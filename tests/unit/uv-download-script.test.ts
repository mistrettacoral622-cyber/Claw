import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('download bundled uv script', () => {
  const scriptSource = readFileSync(
    join(process.cwd(), 'scripts', 'download-bundled-uv.mjs'),
    'utf8',
  );

  it('keeps the tar extraction branch for non-zip archives', () => {
    expect(scriptSource).toContain("command: 'tar'");
    expect(scriptSource).toContain("args: ['-xzf', archivePath, '-C', tempDir]");
   });

  it('keeps the PowerShell zip extraction branch for Windows hosts', () => {
    expect(scriptSource).toContain("if (hostPlatform === 'win32')");
    expect(scriptSource).toContain("command: 'powershell.exe'");
    expect(scriptSource).toContain('Expand-Archive');
    expect(scriptSource).toContain('-Force');
  });

  it('keeps zx-compatible script invocation detection', () => {
    expect(scriptSource).toContain('export function isMainInvocation');
    expect(scriptSource).toContain('.slice(2)');
    expect(scriptSource).toContain('path.resolve(arg) === currentModulePath');
  });
});
