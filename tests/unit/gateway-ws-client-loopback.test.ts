import { describe, expect, it, vi } from 'vitest';

const { constructedUrls, instances } = vi.hoisted(() => ({
  constructedUrls: [] as string[],
  instances: [] as Array<{
    listeners: Map<string, Array<(...args: unknown[]) => void>>;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
  }>,
}));

vi.mock('ws', () => {
  class MockWebSocket {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    send = vi.fn();
    close = vi.fn();

    constructor(url: string) {
      constructedUrls.push(url);
      instances.push({
        listeners: this.listeners,
        send: this.send,
        close: this.close,
        emit: (event: string, ...args: unknown[]) => this.emit(event, ...args),
      });
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const existing = this.listeners.get(event) ?? [];
      existing.push(handler);
      this.listeners.set(event, existing);
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const handler of this.listeners.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return {
    default: MockWebSocket,
  };
});

describe('Gateway WebSocket loopback URL', () => {
  it('uses the backend handshake identity for host Gateway RPC sockets', async () => {
    const { buildGatewayConnectFrame } = await import('@electron/gateway/ws-client');

    const { frame } = buildGatewayConnectFrame({
      challengeNonce: 'nonce',
      token: 'token',
      deviceIdentity: null,
      platform: 'linux',
    });

    expect(frame).toEqual(expect.objectContaining({
      type: 'req',
      method: 'connect',
      params: expect.objectContaining({
        client: expect.objectContaining({
          id: 'gateway-client',
          displayName: 'KTClaw',
          version: '0.1.0',
          mode: 'backend',
        }),
        caps: [],
      }),
    }));
  });

  it('probes the IPv4 loopback address instead of localhost', async () => {
    const { probeGatewayReady } = await import('@electron/gateway/ws-client');

    await probeGatewayReady(18789, 1);

    expect(constructedUrls.at(-1)).toBe('ws://127.0.0.1:18789/ws');
  });

  it('connects to the IPv4 loopback address instead of localhost', async () => {
    const { connectGatewaySocket } = await import('@electron/gateway/ws-client');

    const connectPromise = connectGatewaySocket({
      port: 18789,
      deviceIdentity: null,
      platform: 'linux',
      pendingRequests: new Map(),
      getToken: async () => 'token',
      onHandshakeComplete: vi.fn(),
      onMessage: vi.fn(),
      onCloseAfterHandshake: vi.fn(),
    });

    expect(constructedUrls.at(-1)).toBe('ws://127.0.0.1:18789/ws');

    instances.at(-1)?.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    await expect(connectPromise).rejects.toThrow('refused');
  });
});
