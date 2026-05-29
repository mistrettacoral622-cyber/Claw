import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getBundleRootPackages, getBundledNestedDependencyRepairs } from '../../scripts/bundle-openclaw-lib.mjs';

describe('bundle openclaw script', () => {
  it('includes explicit runtime packages that KTClaw resolves from the OpenClaw context', () => {
    expect(getBundleRootPackages()).toEqual([
      'openclaw',
      '@larksuiteoapi/node-sdk',
    ]);
  });

  it('pins nested dependency repairs for packages that break under flat dependency hoisting', () => {
    expect(getBundledNestedDependencyRepairs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: 'hosted-git-info',
          dependencyName: 'lru-cache',
        }),
      ]),
    );
  });

  it('strips retired channel extension bundles from the packaged openclaw payload', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(source).toContain("'node_modules/@node-llama-cpp'");
    expect(source).toContain("'dist/extensions/discord'");
    expect(source).toContain("'dist/extensions/slack'");
    expect(source).toContain("'dist/extensions/telegram'");
  });

  it('keeps the Linux CLI wrapper usable when copied to /usr/local/bin', () => {
    const wrapper = readFileSync(resolve(process.cwd(), 'resources/cli/posix/openclaw'), 'utf8');

    expect(wrapper).toContain('[ -f "/opt/KTClaw/ktclaw" ]');
    expect(wrapper).toContain('INSTALL_DIR="/opt/KTClaw"');
  });

  it('stores the POSIX CLI wrapper without a UTF-8 BOM before the shebang', () => {
    const wrapper = readFileSync(resolve(process.cwd(), 'resources/cli/posix/openclaw'));

    expect([...wrapper.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(wrapper.subarray(0, 2).toString('utf8')).toBe('#!');
  });
});
