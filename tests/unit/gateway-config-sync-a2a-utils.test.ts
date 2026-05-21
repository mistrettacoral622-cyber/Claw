// @vitest-environment node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { patchA2AUtilsPackageExportsForNodeModules } from '@electron/gateway/config-sync';

const tempRoot = join(process.cwd(), 'tmp-test', 'gateway-config-sync-a2a-utils');

describe('A2A plugin dependency compatibility patching', () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('adds require/default export conditions to @a2anet/a2a-utils copies', async () => {
    const packageDir = join(tempRoot, 'node_modules', '@a2anet', 'a2a-utils');
    const packageJsonPath = join(packageDir, 'package.json');
    await mkdir(packageDir, { recursive: true });
    await writeFile(packageJsonPath, JSON.stringify({
      name: '@a2anet/a2a-utils',
      type: 'module',
      main: './dist/index.js',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
      },
    }), 'utf8');

    expect(patchA2AUtilsPackageExportsForNodeModules(join(tempRoot, 'node_modules'))).toBe(true);

    const patched = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      exports: { '.': { import: string; require: string; default: string } };
    };
    expect(patched.exports['.']).toEqual(expect.objectContaining({
      import: './dist/index.js',
      require: './dist/index.js',
      default: './dist/index.js',
    }));
  });
});
