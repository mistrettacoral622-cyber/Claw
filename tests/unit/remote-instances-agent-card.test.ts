// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyAwareFetchMock = vi.fn();

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => proxyAwareFetchMock(...args),
}));

describe('remote instance Agent Card fetch', () => {
  beforeEach(() => {
    proxyAwareFetchMock.mockReset();
  });

  it('wraps network fetch failures with remote-instance troubleshooting context', async () => {
    proxyAwareFetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { fetchAgentCard } = await import('@electron/services/remote-instances/agent-card');

    await expect(fetchAgentCard({
      url: 'http://10.101.208.178:18789/.well-known/agent-card.json',
      timeoutMs: 1000,
    })).rejects.toThrow(
      'Unable to fetch Agent Card from http://10.101.208.178:18789/.well-known/agent-card.json: fetch failed. Verify the remote Gateway is running',
    );
  });

  it('reports Agent Card request timeouts explicitly', async () => {
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    proxyAwareFetchMock.mockRejectedValue(abortError);
    const { fetchAgentCard } = await import('@electron/services/remote-instances/agent-card');

    await expect(fetchAgentCard({
      url: 'http://10.101.208.178:18789/.well-known/agent-card.json',
      timeoutMs: 1234,
    })).rejects.toThrow(
      'Timed out after 1234ms while fetching Agent Card from http://10.101.208.178:18789/.well-known/agent-card.json',
    );
  });
});
