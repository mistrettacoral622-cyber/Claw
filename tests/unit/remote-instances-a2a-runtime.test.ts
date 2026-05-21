// @vitest-environment node

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testResourcesPath } = vi.hoisted(() => ({
  testResourcesPath: `${process.cwd()}/tmp-test/remote-instances-a2a-runtime-${Math.random().toString(36).slice(2)}`,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  syncA2APluginConfigToOpenClaw: vi.fn(),
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => `${testResourcesPath}/openclaw-config`,
}));

describe('remote instance A2A runtime packaged resolution', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testResourcesPath, { recursive: true, force: true });
  });

  it('uses the bundled A2A plugin copy in packaged builds', async () => {
    const pluginEntry = join(
      testResourcesPath,
      'openclaw-plugins',
      'a2a',
      'node_modules',
      '@a2anet',
      'a2a-utils',
      'dist',
      'index.js',
    );
    await mkdir(join(pluginEntry, '..'), { recursive: true });
    await writeFile(pluginEntry, 'export {};\n', 'utf8');

    const { resolvePackagedA2AUtilsSpecifier } = await import('@electron/services/remote-instances/a2a-runtime');

    expect(resolvePackagedA2AUtilsSpecifier({
      isPackaged: true,
      resourcesPath: testResourcesPath,
    })).toBe(pathToFileURL(pluginEntry).href);
  });

  it('falls back to the bundled OpenClaw dependency copy when needed', async () => {
    const openclawEntry = join(
      testResourcesPath,
      'openclaw',
      'node_modules',
      '@a2anet',
      'a2a-utils',
      'dist',
      'index.js',
    );
    await mkdir(join(openclawEntry, '..'), { recursive: true });
    await writeFile(openclawEntry, 'export {};\n', 'utf8');

    const { resolvePackagedA2AUtilsSpecifier } = await import('@electron/services/remote-instances/a2a-runtime');

    expect(resolvePackagedA2AUtilsSpecifier({
      isPackaged: true,
      resourcesPath: testResourcesPath,
    })).toBe(pathToFileURL(openclawEntry).href);
  });

  it('does not override package resolution in dev mode', async () => {
    const { resolvePackagedA2AUtilsSpecifier } = await import('@electron/services/remote-instances/a2a-runtime');

    expect(resolvePackagedA2AUtilsSpecifier({
      isPackaged: false,
      resourcesPath: testResourcesPath,
    })).toBeNull();
  });
});
