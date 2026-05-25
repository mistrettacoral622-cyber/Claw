export interface ChatMediaLike {
  filePath: string;
  mimeType: string;
  fileName?: string | null;
}

export const VISION_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/bmp',
  'image/webp',
]);

export function isVisionMimeType(mimeType: string | null | undefined): boolean {
  return VISION_MIME_TYPES.has((mimeType ?? '').trim().toLowerCase());
}

export function buildMediaReference(media: ChatMediaLike): string {
  return `[media attached: ${media.filePath} (${media.mimeType}) | ${media.filePath}]`;
}

export function appendMediaReferences(
  message: string,
  media: Array<ChatMediaLike> | null | undefined,
): string {
  const references = (media ?? []).map(buildMediaReference);
  return [message.trim(), ...references].filter(Boolean).join('\n');
}

export function isTextOnlyImageSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('image_url')
    || (normalized.includes('expected text') && normalized.includes('image'))
    || (normalized.includes('unknown variant') && normalized.includes('image'));
}
