import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  loadMiniMaxPortalOAuthModule,
  loadQwenPortalOAuthModule,
} from '@electron/utils/openclaw-oauth-runtime';

const OPENCLAW_DIR = join(process.cwd(), 'node_modules', 'openclaw');

function hasOauthRuntimeBundle() {
  const distDir = join(OPENCLAW_DIR, 'dist');
  return existsSync(distDir) && readdirSync(distDir).some((name) => /^oauth\.runtime-.*\.js$/.test(name));
}

describe('openclaw oauth runtime loader', () => {
  it.skipIf(!hasOauthRuntimeBundle())('loads MiniMax device OAuth from the published openclaw dist runtime', async () => {
    const runtime = await loadMiniMaxPortalOAuthModule(OPENCLAW_DIR);

    expect(typeof runtime.loginMiniMaxPortalOAuth).toBe('function');
  }, 30000);

  it.skipIf(!hasOauthRuntimeBundle())('loads Qwen device OAuth from the published openclaw dist runtime', async () => {
    const runtime = await loadQwenPortalOAuthModule(OPENCLAW_DIR);

    expect(typeof runtime.loginQwenPortalOAuth).toBe('function');
  }, 30000);
});
