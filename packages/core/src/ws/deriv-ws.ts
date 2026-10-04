import { getPublicWsUrl } from '../config/urls';

type MessageHandler = (data: Record<string, unknown>) => void;
type ConnectionStateHandler = (connected: boolean) => void;
type ReconnectExhaustedHandler = () => void;

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long a one-shot request may wait for its response before it is rejected. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Supplies a fresh single-use authenticated WebSocket URL (OTP) on demand. */
export type UrlProvider = () => Promise<string>;

/** One real API subscription, potentially multiplexed across several callers. */
interface KeyedSubscription {
  subscriptionId: string | null;
  handlers: Set<MessageHandler>;
}

/**
 * Lightweight WebSocket manager for the Deriv public WS API.
 * Handles connection, reconnection, request/response matching via req_id,
 * and subscription streaming.
 */
export class DerivWS {
  private ws: WebSocket | null = null;
  private reqIdCounter = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  // Real, in-flight-or-live API subscriptions, keyed by a canonical form of
  // their request payload (e.g. `ticks=R_100`). Deriv's API rejects a second
  // `subscribe: 1` for the same thing with an `AlreadySubscribed` error, so
  // independent callers asking for the same stream (e.g. the trade panel and
  // the digit-alerts watcher both wanting ticks for the same symbol) share a
  // single underlying subscription here instead of racing each other.
  private subscriptionsByKey = new Map<string, KeyedSubscription>();
  private subscriptionIdToKey = new Map<string, string>();
  private pendingSubscribes = new Map<string, Promise<{ subscriptionId: string | null }>>();
  private globalHandlers: MessageHandler[] = [];
  private connectionStateHandlers: ConnectionStateHandler[] = [];
  private reconnectExhaustedHandlers: ReconnectExhaustedHandler[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private url: string;
  private connectPromise: Promise<void> | null = null;
  private urlProvider: UrlProvider | null = null;
  // Set by disconnect(): the socket was closed on purpose, never reconnect.
  private closedByUser = false;

  constructor(url?: string) {
    this.url = url ?? getPublicWsUrl();
  }

  /**
   * Register a listener for connection state changes.
   * Called with `true` on connect and `false` on disconnect.
   * Returns an unsubscribe function.
   */
  onConnectionStateChange(handler: ConnectionStateHandler): () => void {
    this.connectionStateHandlers.push(handler);
    return () => {
      this.connectionStateHandlers = this.connectionStateHandlers.filter((h) => h !== handler);
    };
  }

  onReconnectExhausted(handler: ReconnectExhaustedHandler): () => void {
    this.reconnectExhaustedHandlers.push(handler);
    return () => {
      this.reconnectExhaustedHandlers = this.reconnectExhaustedHandlers.filter((h) => h !== handler);
    };
  }

  private notifyConnectionState(connected: boolean): void {
    for (const handler of this.connectionStateHandlers) {
      handler(connected);
    }
  }

  /**
   * Update the URL used for future reconnections without disrupting the current connection.
   * Call this when an OTP URL is refreshed but the live socket is still healthy.
   */
  updateUrl(url: string): void {
    this.url = url;
  }

  /**
   * Authenticated URLs (OTPs) are single-use, so reconnecting to the URL we
   * originally connected with fails. When a provider is set, every reconnect
   * attempt first asks it for a fresh URL.
   */
  setUrlProvider(provider: UrlProvider | null): void {
    this.urlProvider = provider;
  }

  /** Reject every in-flight request so callers never hang on a dead socket. */
  private rejectAllPending(reason: string): void {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  private registerPending(
    reqId: number,
    resolve: PendingRequest['resolve'],
    reject: PendingRequest['reject']
  ): void {
    const timer = setTimeout(() => {
      if (this.pendingRequests.delete(reqId)) {
        reject(new Error('Request timed out'));
      }
    }, REQUEST_TIMEOUT_MS);
    this.pendingRequests.set(reqId, { resolve, reject, timer });
  }

  private takePending(reqId: number): PendingRequest | undefined {
    const pending = this.pendingRequests.get(reqId);
    if (!pending) return undefined;
    this.pendingRequests.delete(reqId);
    clearTimeout(pending.timer);
    return pending;
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    // A connection attempt is already in flight — share it instead of
    // polling (which leaked a timer forever if the attempt failed).
    if (this.connectPromise) return this.connectPromise;

    this.closedByUser = false;

    const attempt = new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.connectPromise = null;
        this.reconnectAttempts = 0;
        this.startPing();
        this.notifyConnectionState(true);
        resolve();
      };

      this.ws.onmessage = (event) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data);
        } catch {
          return; // ignore a malformed frame rather than throwing in the socket callback
        }
        this.handleMessage(data);
      };

      this.ws.onerror = () => {
        this.connectPromise = null;
        reject(new Error('WebSocket connection error'));
      };

      this.ws.onclose = () => {
        this.connectPromise = null;
        this.stopPing();
        // The server drops every subscription when the socket closes, so
        // our bookkeeping of "what's live" must be wiped too — otherwise a
        // future subscribe() for the same payload would think it can
        // multiplex onto a subscription that no longer exists server-side.
        this.subscriptionsByKey.clear();
        this.subscriptionIdToKey.clear();
        this.pendingSubscribes.clear();
        // Anything still waiting for a reply will never get one.
        this.rejectAllPending('WebSocket closed');
        // No-op if the attempt already settled; unblocks it if it never opened.
        reject(new Error('WebSocket closed'));
        if (this.closedByUser) return;
        this.notifyConnectionState(false);
        this.attemptReconnect();
      };
    });
    this.connectPromise = attempt;
    return attempt;
  }

  /**
   * Send a one-shot request and wait for the response matched by req_id.
   */
  send<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not connected'));
        return;
      }

      const reqId = ++this.reqIdCounter;
      const message = { ...payload, req_id: reqId };

      this.registerPending(
        reqId,
        resolve as (data: Record<string, unknown>) => void,
        reject
      );

      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        this.takePending(reqId);
        reject(err instanceof Error ? err : new Error('Send failed'));
      }
    });
  }

  /** Stable string for a subscribe payload, independent of key insertion order. */
  private subscriptionKey(payload: Record<string, unknown>): string {
    return Object.keys(payload)
      .sort()
      .map((k) => `${k}=${JSON.stringify(payload[k])}`)
      .join('&');
  }

  /**
   * Send a subscription request. The handler is called for every streamed message.
   * Returns a function to unsubscribe.
   *
   * If another caller already has an identical subscription open (or in
   * flight), this multiplexes onto it via a shared `MessageHandler` set
   * rather than issuing a second `subscribe: 1` for the same thing — the API
   * rejects duplicates with an `AlreadySubscribed` error, which previously
   * meant whichever caller lost the race silently stopped receiving updates.
   */
  subscribe(
    payload: Record<string, unknown>,
    handler: MessageHandler
  ): Promise<{ subscriptionId: string | null; unsubscribe: () => void }> {
    const key = this.subscriptionKey(payload);

    const unsubscribe = () => {
      const entry = this.subscriptionsByKey.get(key);
      if (!entry) return;
      entry.handlers.delete(handler);
      if (entry.handlers.size > 0) return; // other callers still listening
      this.subscriptionsByKey.delete(key);
      if (entry.subscriptionId) {
        this.subscriptionIdToKey.delete(entry.subscriptionId);
        this.send({ forget: entry.subscriptionId }).catch(() => {});
      }
    };

    // Already live — just add this handler to the existing stream.
    const existing = this.subscriptionsByKey.get(key);
    if (existing) {
      existing.handlers.add(handler);
      return Promise.resolve({ subscriptionId: existing.subscriptionId, unsubscribe });
    }

    // Already being requested by someone else — wait for it, then join it.
    const pending = this.pendingSubscribes.get(key);
    if (pending) {
      return pending.then(({ subscriptionId }) => {
        this.subscriptionsByKey.get(key)?.handlers.add(handler);
        return { subscriptionId, unsubscribe };
      });
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not connected'));
    }

    const entry: KeyedSubscription = { subscriptionId: null, handlers: new Set([handler]) };
    this.subscriptionsByKey.set(key, entry);

    const reqId = ++this.reqIdCounter;
    const message = { ...payload, subscribe: 1, req_id: reqId };

    const promise = new Promise<{ subscriptionId: string | null }>((resolve, reject) => {
      this.registerPending(
        reqId,
        (data) => {
          const subscriptionId = this.extractSubscriptionId(data);
          entry.subscriptionId = subscriptionId;
          if (subscriptionId) this.subscriptionIdToKey.set(subscriptionId, key);
          // Deliver the initial response to every handler that joined while
          // this was in flight, not just the one that triggered the request.
          for (const h of entry.handlers) h(data);
          resolve({ subscriptionId });
        },
        (err) => {
          this.subscriptionsByKey.delete(key);
          reject(err);
        }
      );
      try {
        this.ws!.send(JSON.stringify(message));
      } catch (err) {
        this.takePending(reqId);
        this.subscriptionsByKey.delete(key);
        reject(err instanceof Error ? err : new Error('Send failed'));
      }
    }).finally(() => {
      this.pendingSubscribes.delete(key);
    });

    this.pendingSubscribes.set(key, promise);

    return promise.then(({ subscriptionId }) => ({ subscriptionId, unsubscribe }));
  }

  onMessage(handler: MessageHandler): () => void {
    this.globalHandlers.push(handler);
    return () => {
      this.globalHandlers = this.globalHandlers.filter((h) => h !== handler);
    };
  }

  disconnect(): void {
    this.stopPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.closedByUser = true;
    this.reconnectAttempts = this.maxReconnectAttempts; // prevent reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connectPromise = null;
    this.rejectAllPending('WebSocket disconnected');
    this.subscriptionsByKey.clear();
    this.subscriptionIdToKey.clear();
    this.pendingSubscribes.clear();
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handleMessage(data: Record<string, unknown>): void {
    // Notify global handlers
    for (const handler of this.globalHandlers) {
      handler(data);
    }

    const reqId = data.req_id as number | undefined;

    // Check for error
    if (data.error) {
      if (reqId) {
        this.takePending(reqId)?.reject(
          new Error((data.error as Record<string, string>).message)
        );
      }
      return;
    }

    // Check if this is a subscription stream — fan it out to every handler
    // multiplexed onto this subscription id.
    const subId = this.extractSubscriptionId(data);
    if (subId) {
      const key = this.subscriptionIdToKey.get(subId);
      const entry = key ? this.subscriptionsByKey.get(key) : undefined;
      if (entry) {
        for (const h of entry.handlers) h(data);
      }
    }

    // Resolve pending one-shot request
    if (reqId) {
      this.takePending(reqId)?.resolve(data);
    }
  }

  private extractSubscriptionId(data: Record<string, unknown>): string | null {
    // Subscription ID can be in tick.id, subscription.id, or proposal.id
    if (data.subscription && typeof data.subscription === 'object') {
      return (data.subscription as Record<string, string>).id ?? null;
    }
    if (data.tick && typeof data.tick === 'object') {
      return (data.tick as Record<string, string>).id ?? null;
    }
    return null;
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      for (const handler of this.reconnectExhaustedHandlers) handler();
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    this.reconnectTimeout = setTimeout(async () => {
      // Authenticated URLs are single-use: get a fresh one before retrying.
      if (this.urlProvider) {
        try {
          this.url = await this.urlProvider();
        } catch {
          // Couldn't mint a URL (offline / token problem) — burn this
          // attempt and back off rather than reusing the spent one.
          this.attemptReconnect();
          return;
        }
      }
      if (this.closedByUser) return; // disconnected while we were awaiting
      this.connect().catch(() => {});
    }, delay);
  }
}
