import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type AfterPackTestExports = {
  __test?: {
    cleanupOnnxRuntimeNodeBinaries?: (nodeModulesDir: string, platform: string, arch: string) => number;
  };
};

const afterPack = require(resolve(process.cwd(), 'scripts/after-pack.cjs')) as AfterPackTestExports;

describe('after-pack cleanup helpers', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes non-target onnxruntime-node native binaries from direct and nested runtime deps', () => {
    const cleanup = afterPack.__test?.cleanupOnnxRuntimeNodeBinaries;
    expect(cleanup).toBeTypeOf('function');

    const root = join(tmpdir(), `ktclaw-after-pack-${Date.now()}`);
    roots.push(root);
    const nodeModulesDir = join(root, 'node_modules');
    const directRuntime = join(nodeModulesDir, 'onnxruntime-node', 'bin', 'napi-v3');
    const nestedRuntime = join(nodeModulesDir, '@xenova', 'transformers', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');

    for (const base of [directRuntime, nestedRuntime]) {
      for (const platform of ['darwin', 'linux', 'win32']) {
        for (const arch of ['arm64', 'x64']) {
          const file = join(base, platform, arch, 'onnxruntime_binding.node');
          mkdirSync(join(file, '..'), { recursive: true });
          writeFileSync(file, 'binary');
        }
      }
    }

    const removed = cleanup!(nodeModulesDir, 'win32', 'x64');

    expect(removed).toBeGreaterThan(0);
    expect(existsSync(join(directRuntime, 'win32', 'x64', 'onnxruntime_binding.node'))).toBe(true);
    expect(existsSync(join(nestedRuntime, 'win32', 'x64', 'onnxruntime_binding.node'))).toBe(true);
    expect(existsSync(join(directRuntime, 'darwin'))).toBe(false);
    expect(existsSync(join(directRuntime, 'linux'))).toBe(false);
    expect(existsSync(join(directRuntime, 'win32', 'arm64'))).toBe(false);
    expect(existsSync(join(nestedRuntime, 'darwin'))).toBe(false);
    expect(existsSync(join(nestedRuntime, 'linux'))).toBe(false);
    expect(existsSync(join(nestedRuntime, 'win32', 'arm64'))).toBe(false);
  });
});
