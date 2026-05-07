import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyAwareFetch = vi.fn();
const mkdir = vi.fn();
const writeFile = vi.fn();

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch,
}));

vi.mock('@electron/services/image-generation/credential-resolver', () => ({
  resolveDashScopeCredentials: vi.fn().mockResolvedValue({
    apiKey: 'sk-test',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    source: 'provider',
    accountId: 'dashscope',
  }),
}));

vi.mock('@electron/utils/generated-media', () => ({
  buildGeneratedImagePath: vi.fn(() => 'C:/ktclaw/generated/test.png'),
  getGeneratedMediaDir: vi.fn(() => 'C:/ktclaw/generated'),
}));

vi.mock('node:fs/promises', () => ({
  default: { mkdir, writeFile },
  mkdir,
  writeFile,
}));

describe('generateDashScopeWanImage', () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    mkdir.mockReset();
    writeFile.mockReset();
  });

  it('does not send the unsupported DashScope async header', async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: {
          choices: [
            {
              message: {
                content: [
                  {
                    type: 'image',
                    image: 'https://dashscope.example.com/image.png',
                  },
                ],
              },
            },
          ],
        },
        request_id: 'request-1',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }));

    const { generateDashScopeWanImage } = await import('@electron/services/image-generation/dashscope-wan');
    const result = await generateDashScopeWanImage({
      prompt: 'two ragdoll cats',
      size: '1280*1280',
    });

    expect(result.metadata.provider).toBe('dashscope');
    expect(proxyAwareFetch).toHaveBeenNthCalledWith(
      1,
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      expect.objectContaining({
        method: 'POST',
        headers: expect.not.objectContaining({
          'X-DashScope-Async': expect.any(String),
        }),
      }),
    );
    expect(writeFile).toHaveBeenCalledWith(
      'C:/ktclaw/generated/test.png',
      Buffer.from([1, 2, 3]),
    );
  });
});
