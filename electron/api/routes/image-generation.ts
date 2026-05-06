import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { redactDashScopeError } from '../../services/image-generation/credential-resolver';
import { generateDashScopeWanImage } from '../../services/image-generation/dashscope-wan';

const MISSING_CREDENTIAL_ERROR = '还没有配置图片生成服务。请前往设置添加 DashScope，或设置 DASHSCOPE_API_KEY。';

function isValidImageSize(value: string): boolean {
  return /^\d+\*\d+$/.test(value);
}

export async function handleImageGenerationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname !== '/api/image-generation/generate' || req.method !== 'POST') {
    return false;
  }

  try {
    const body = await parseJsonBody<{
      prompt?: string;
      negativePrompt?: string;
      size?: string;
      accountId?: string;
      baseUrl?: string;
    }>(req);

    const prompt = body.prompt?.trim() || '';
    if (!prompt) {
      sendJson(res, 400, { success: false, error: 'Prompt is required' });
      return true;
    }

    const size = body.size?.trim() || '1280*1280';
    if (!isValidImageSize(size)) {
      sendJson(res, 400, { success: false, error: 'Invalid size format' });
      return true;
    }

    const image = await generateDashScopeWanImage({
      prompt,
      negativePrompt: body.negativePrompt,
      size,
      accountId: body.accountId,
    });

    sendJson(res, 200, { success: true, image });
  } catch (error) {
    const message = redactDashScopeError(error);
    if (message.includes('DASHSCOPE_CREDENTIAL_MISSING')) {
      sendJson(res, 200, {
        success: false,
        code: 'DASHSCOPE_CREDENTIAL_MISSING',
        error: MISSING_CREDENTIAL_ERROR,
      });
      return true;
    }
    sendJson(res, 500, { success: false, error: message });
  }

  return true;
}

export { MISSING_CREDENTIAL_ERROR };
