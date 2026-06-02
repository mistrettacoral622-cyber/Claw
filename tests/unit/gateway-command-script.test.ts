// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildGatewayCommandScript } from '@electron/gateway/config-sync';

describe('gateway command script', () => {
  it('uses the Electron runtime as Node so gateway.cmd does not depend on system Node', () => {
    const script = buildGatewayCommandScript({
      electronRuntimePath: 'C:\\Program Files\\KTClaw\\KTClaw.exe',
      openclawEntryPath: 'C:\\Program Files\\KTClaw\\resources\\openclaw\\openclaw.mjs',
      openclawConfigDir: 'C:\\Users\\tester\\.openclaw',
      port: 18789,
      openclawVersion: '2026.4.8',
      homeDir: 'C:\\Users\\tester',
      tmpDir: 'C:\\Users\\tester\\AppData\\Local\\Temp',
    });

    expect(script).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(script).toContain('set "OPENCLAW_NODE_OPTIONS_READY=1"');
    expect(script).toContain('set "OPENCLAW_DISABLE_BONJOUR=1"');
    expect(script).toContain('set "OPENCLAW_NO_RESPAWN=1"');
    expect(script).toContain('set "OPENCLAW_CONFIG_PATH=C:\\Users\\tester\\.openclaw\\openclaw.json"');
    expect(script).toContain('"C:\\Program Files\\KTClaw\\KTClaw.exe" "C:\\Program Files\\KTClaw\\resources\\openclaw\\openclaw.mjs" gateway --port 18789 --allow-unconfigured');
    expect(script).not.toContain('node.exe');
  });
});
