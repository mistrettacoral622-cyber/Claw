import { mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { buildGeneratedImagePath, getGeneratedMediaDir } from '../../utils/generated-media';
import { resolveDashScopeCredentials } from './credential-resolver';

export interface GenerateImageRequest {
  prompt: string;
  negativePrompt?: string;
  size?: string;
  accountId?: string;
}

export interface GeneratedImageResult {
  filePath: string;
  mimeType: string;
  preview: string | null;
  metadata: {
    provider: 'dashscope';
    model: 'wan2.6-t2i';
    size: string;
    prompt: string;
    requestId?: string;
    source: 'provider' | 'env';
  };
}

interface DashScopeImageContentBlock {
  type?: string;
  image?: string;
}

interface DashScopeResponse {
  request_id?: string;
  output?: {
    choices?: Array<{
      message?: {
        content?: DashScopeImageContentBlock[];
      };
    }>;
  };
}

const DEFAULT_IMAGE_SIZE = '1280*1280';

function inferMimeType(filePath: string, contentTypeHeader?: string | null): string {
  const header = contentTypeHeader?.split(';')[0]?.trim().toLowerCase();
  if (header?.startsWith('image/')) {
    return header;
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  return 'image/png';
}

function getImageUrl(response: DashScopeResponse): string | null {
  const content = response.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const imageBlock = content.find((entry) => entry?.type === 'image' && typeof entry.image === 'string');
  return imageBlock?.image ?? null;
}

export async function generateDashScopeWanImage(request: GenerateImageRequest): Promise<GeneratedImageResult> {
  const credentials = await resolveDashScopeCredentials({ accountId: request.accountId });
  if (!credentials) {
    throw new Error('DASHSCOPE_CREDENTIAL_MISSING');
  }

  const size = request.size?.trim() || DEFAULT_IMAGE_SIZE;
  const response = await proxyAwareFetch(credentials.baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'false',
    },
    body: JSON.stringify({
      model: 'wan2.6-t2i',
      input: {
        messages: [
          {
            role: 'user',
            content: [{ text: request.prompt }],
          },
        ],
      },
      parameters: {
        size,
        n: 1,
        prompt_extend: true,
        watermark: false,
        ...(request.negativePrompt?.trim() ? { negative_prompt: request.negativePrompt.trim() } : {}),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json() as DashScopeResponse;
  const imageUrl = getImageUrl(payload);
  if (!imageUrl) {
    throw new Error('DashScope response did not include an image URL');
  }

  const imageResponse = await proxyAwareFetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(await imageResponse.text());
  }

  const contentType = imageResponse.headers.get('content-type');
  const mimeType = inferMimeType(imageUrl, contentType);
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const filePath = buildGeneratedImagePath({
    prompt: request.prompt,
    mimeType,
    requestId: payload.request_id,
  });

  await mkdir(getGeneratedMediaDir(), { recursive: true });
  await writeFile(filePath, imageBuffer);

  return {
    filePath,
    mimeType,
    preview: `data:${mimeType};base64,${imageBuffer.toString('base64')}`,
    metadata: {
      provider: 'dashscope',
      model: 'wan2.6-t2i',
      size,
      prompt: request.prompt,
      requestId: payload.request_id || basename(filePath),
      source: credentials.source,
    },
  };
}
