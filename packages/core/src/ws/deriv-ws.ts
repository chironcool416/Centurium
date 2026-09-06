import { getPublicWsUrl } from '../config/urls';

type MessageHandler = (data: Record<string, unknown>) => void;
type ConnectionStateHandler = (connected: boolean) => void;
type ReconnectExhaustedHandler = () => void;

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

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
  private isConnecting = false;

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

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.isConnecting) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startPing();
        this.notifyConnectionState(true);
        resolve();
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      };

      this.ws.onerror = () => {
        this.isConnecting = false;
        reject(new Error('WebSocket connection error'));
      };

      this.ws.onclose = () => {
        this.isConnecting = false;
        this.stopPing();
        // The server drops every subscription when the socket closes, so
        // our bookkeeping of "what's live" must be wiped too — otherwise a
        // future subscribe() for the same payload would think it can
        // multiplex onto a subscription that no longer exists server-side.
        this.subscriptionsByKey.clear();
        this.subscriptionIdToKey.clear();
        this.pendingSubscribes.clear();
        this.notifyConnectionState(false);
        this.attemptReconnect();
      };
    });
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

      this.pendingRequests.set(reqId, {
        resolve: resolve as (data: Record<string, unknown>) => void,
        reject,
      });

      this.ws.send(JSON.stringify(message));
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
      this.pendingRequests.set(reqId, {
        resolve: (data) => {
          const subscriptionId = this.extractSubscriptionId(data);
          entry.subscriptionId = subscriptionId;
          if (subscriptionId) this.subscriptionIdToKey.set(subscriptionId, key);
          // Deliver the initial response to every handler that joined while
          // this was in flight, not just the one that triggered the request.
          for (const h of entry.handlers) h(data);
          resolve({ subscriptionId });
        },
        reject: (err) => {
          this.subscriptionsByKey.delete(key);
          reject(err);
        },
      });
      this.ws!.send(JSON.stringify(message));
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
    this.reconnectAttempts = this.maxReconnectAttempts; // prevent reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pendingRequests.clear();
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
      if (reqId && this.pendingRequests.has(reqId)) {
        const pending = this.pendingRequests.get(reqId)!;
        this.pendingRequests.delete(reqId);
        pending.reject(new Error((data.error as Record<string, string>).message));
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
    if (reqId && this.pendingRequests.has(reqId)) {
      const pending = this.pendingRequests.get(reqId)!;
      this.pendingRequests.delete(reqId);
      pending.resolve(data);
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
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      for (const handler of this.reconnectExhaustedHandlers) handler();
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }
}
