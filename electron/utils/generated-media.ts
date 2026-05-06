import crypto from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { getOpenClawConfigDir } from './paths';

const GENERATED_MEDIA_DIR = join(getOpenClawConfigDir(), 'media', 'generated');

function normalizePath(value: string): string {
  const resolved = resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sanitizePrompt(prompt: string): string {
  return prompt
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    || 'generated-image';
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return '.jpg';
  }
  if (normalized === 'image/webp') {
    return '.webp';
  }
  const ext = extname(normalized);
  return ext || '.png';
}

export function getGeneratedMediaDir(): string {
  return GENERATED_MEDIA_DIR;
}

export function isGeneratedMediaPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return false;
  }
  const base = normalizePath(GENERATED_MEDIA_DIR);
  const target = normalizePath(filePath);
  if (target === base) {
    return true;
  }
  const baseWithSep = base.endsWith(sep) ? base : `${base}${sep}`;
  return target.startsWith(baseWithSep);
}

export function buildGeneratedImagePath(options: { prompt: string; mimeType: string; requestId?: string }): string {
  const prefix = sanitizePrompt(options.prompt);
  const requestId = options.requestId || crypto.randomUUID();
  const extension = extensionForMimeType(options.mimeType);
  return join(GENERATED_MEDIA_DIR, `${prefix}-${requestId}${extension}`);
}
