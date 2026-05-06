import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const generateDashScopeWanImageMock = vi.fn();
const redactDashScopeErrorMock = vi.fn((value: unknown) => String(value));

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/services/image-generation/dashscope-wan', () => ({
  generateDashScopeWanImage: (...args: unknown[]) => generateDashScopeWanImageMock(...args),
}));

vi.mock('@electron/services/image-generation/credential-resolver', () => ({
  redactDashScopeError: (...args: unknown[]) => redactDashScopeErrorMock(...args),
}));

describe('image generation route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 400 when prompt is missing', async () => {
    parseJsonBodyMock.mockResolvedValue({ prompt: '   ' });
    const { handleImageGenerationRoutes } = await import('@electron/api/routes/image-generation');

    const handled = await handleImageGenerationRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/image-generation/generate'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, {
      success: false,
      error: 'Prompt is required',
    });
  });

  it('returns a setup-oriented error when credentials are missing', async () => {
    parseJsonBodyMock.mockResolvedValue({ prompt: '一只橘猫' });
    generateDashScopeWanImageMock.mockRejectedValue(new Error('DASHSCOPE_CREDENTIAL_MISSING'));
    const { handleImageGenerationRoutes } = await import('@electron/api/routes/image-generation');

    await handleImageGenerationRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/image-generation/generate'),
      {} as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: false,
      code: 'DASHSCOPE_CREDENTIAL_MISSING',
      error: '还没有配置图片生成服务。请前往设置添加 DashScope，或设置 DASHSCOPE_API_KEY。',
    });
  });

  it('returns local generated image metadata on success', async () => {
    parseJsonBodyMock.mockResolvedValue({
      prompt: '一只橘猫',
      negativePrompt: '模糊',
      size: '1280*1280',
      baseUrl: 'https://malicious.example.com',
    });
    generateDashScopeWanImageMock.mockResolvedValue({
      filePath: 'C:/Users/22688/.openclaw/media/generated/cat.png',
      mimeType: 'image/png',
      preview: 'data:image/png;base64,abc',
      metadata: {
        provider: 'dashscope',
        model: 'wan2.6-t2i',
        size: '1280*1280',
        prompt: '一只橘猫',
        requestId: 'req-1',
        source: 'env',
      },
    });

    const { handleImageGenerationRoutes } = await import('@electron/api/routes/image-generation');

    await handleImageGenerationRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/image-generation/generate'),
      {} as never,
    );

    expect(generateDashScopeWanImageMock).toHaveBeenCalledWith({
      prompt: '一只橘猫',
      negativePrompt: '模糊',
      size: '1280*1280',
      accountId: undefined,
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      image: expect.objectContaining({
        filePath: expect.stringContaining('media/generated'),
        mimeType: 'image/png',
        preview: expect.stringContaining('data:image/png;base64,'),
      }),
    });
  });
});
