import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DerivWS } from './deriv-ws';

class MockSocket {
  static OPEN = 1;
  static instances: MockSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    MockSocket.instances.push(this);
  }
  send(msg: string) {
    this.sent.push(JSON.parse(msg));
  }
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose?.(), 0);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  MockSocket.instances = [];
  vi.stubGlobal('WebSocket', MockSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connected(url = 'wss://x/otp-1') {
  const ws = new DerivWS(url);
  const p = ws.connect();
  MockSocket.instances[0].open();
  await p;
  return ws;
}

describe('DerivWS', () => {
  it('rejects in-flight requests when the socket drops', async () => {
    const ws = await connected();
    const req = ws.send({ buy: 'abc' });
    const assertion = expect(req).rejects.toThrow('WebSocket closed');
    MockSocket.instances[0].drop();
    await assertion;
    ws.disconnect();
  });

  it('times out a request that never gets a reply', async () => {
    const ws = await connected();
    const req = ws.send({ ping: 1 });
    const assertion = expect(req).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
    ws.disconnect();
  });

  it('asks the provider for a fresh URL on every reconnect', async () => {
    const ws = await connected('wss://x/otp-1');
    let n = 1;
    ws.setUrlProvider(async () => `wss://x/otp-${++n}`);

    MockSocket.instances[0].drop();
    await vi.advanceTimersByTimeAsync(2_100); // first backoff = 2s
    expect(MockSocket.instances).toHaveLength(2);
    expect(MockSocket.instances[1].url).toBe('wss://x/otp-2');

    MockSocket.instances[1].drop(); // fails before ever opening
    await vi.advanceTimersByTimeAsync(4_100);
    expect(MockSocket.instances[2].url).toBe('wss://x/otp-3');
    ws.disconnect();
  });

  it('keeps backing off (and never dials the spent URL) when the provider fails', async () => {
    const ws = await connected('wss://x/otp-1');
    ws.setUrlProvider(async () => {
      throw new Error('offline');
    });
    MockSocket.instances[0].drop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(MockSocket.instances).toHaveLength(1); // never reconnected to the stale OTP
    ws.disconnect();
  });

  it('does not reconnect after an intentional disconnect', async () => {
    const ws = await connected();
    ws.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  it('ignores malformed frames instead of throwing', async () => {
    const ws = await connected();
    expect(() => MockSocket.instances[0].onmessage?.({ data: 'not json' })).not.toThrow();
    ws.disconnect();
  });

  it('shares one in-flight connect() instead of polling', async () => {
    const ws = new DerivWS('wss://x/otp-1');
    const a = ws.connect();
    const b = ws.connect();
    expect(MockSocket.instances).toHaveLength(1);
    MockSocket.instances[0].open();
    await Promise.all([a, b]);
    ws.disconnect();
  });
});
