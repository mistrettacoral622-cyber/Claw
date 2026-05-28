import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('E2E / release smoke guardrails', () => {
  it('does not allow the e2e script to silently pass with zero tests', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['test:e2e']).toBeDefined();
    expect(packageJson.scripts?.['test:e2e']).not.toContain('--pass-with-no-tests');
    expect(packageJson.scripts?.['test:e2e:headed']).not.toContain('--pass-with-no-tests');
  });

  it('includes Playwright config and multiple real smoke specs', () => {
    expect(existsSync(resolve(process.cwd(), 'playwright.config.ts'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'tests/e2e/app-smoke.spec.ts'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'tests/e2e/routes-smoke.spec.ts'))).toBe(true);
  });

  it('keeps release packaging scripts aligned with preinstalled-skills bundling', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts['package:prepare']).toContain('bundle:openclaw');
    expect(scripts['package:prepare']).toContain('bundle:openclaw-plugins');
    expect(scripts['package:prepare']).toContain('bundle:preinstalled-skills');
    expect(scripts['package:prepare']).toContain('model:download');

    expect(scripts['package:mac:ci']).toContain('--publish never');
    expect(scripts['package:win:ci']).toContain('--publish never');
    expect(scripts['package:linux:ci']).toContain('--publish never');
    expect(scripts['smoke:linux']).toContain('package:linux:smoke');
  });

  it('bundles externalized Electron main runtime dependencies for packaged apps', () => {
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    const afterPack = readFileSync(resolve(process.cwd(), 'scripts/after-pack.cjs'), 'utf8');

    expect(viteConfig).toContain("'@xenova/transformers'");
    expect(viteConfig).toContain("'ssh2'");
    expect(afterPack).toContain("'@xenova/transformers'");
    expect(afterPack).toContain("'ssh2'");
  });

  it('lazy-loads ssh2 so host preparation can run without SSH client module loading', () => {
    const intercomService = readFileSync(resolve(process.cwd(), 'electron/services/intercom.ts'), 'utf8');

    expect(intercomService).not.toMatch(/import\s+\{\s*Client[\s\S]*from ['"]ssh2['"]/);
    expect(intercomService).toContain("await import('ssh2')");
  });

  it('includes packaged startup and Linux release/install smoke scripts', () => {
    expect(existsSync(resolve(process.cwd(), 'scripts/smoke/packaged-startup.mjs'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'scripts/smoke/release-smoke.mjs'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'scripts/smoke/install-smoke-linux.mjs'))).toBe(true);
  });

  it('guards A2A plugin resources in packaged startup and release smoke checks', () => {
    const startupSmoke = readFileSync(resolve(process.cwd(), 'scripts/smoke/packaged-startup.mjs'), 'utf8');
    const releaseSmoke = readFileSync(resolve(process.cwd(), 'scripts/smoke/release-smoke.mjs'), 'utf8');
    const installSmokeLinux = readFileSync(resolve(process.cwd(), 'scripts/smoke/install-smoke-linux.mjs'), 'utf8');

    for (const content of [startupSmoke, releaseSmoke, installSmokeLinux]) {
      expect(content).toMatch(/openclaw-plugins(?:\\\/|\/)a2a(?:\\\/|\/)openclaw\\?\.plugin\\?\.json/);
      expect(content).toMatch(/@a2anet(?:\\\/|\/)a2a-utils/);
      expect(content).toMatch(/dist(?:\\\/|\/)index\\?\.js/);
    }
  });

  it('guards OpenClaw runtime SDK resources required by packaged doctor probes', () => {
    const startupSmoke = readFileSync(resolve(process.cwd(), 'scripts/smoke/packaged-startup.mjs'), 'utf8');
    const releaseSmoke = readFileSync(resolve(process.cwd(), 'scripts/smoke/release-smoke.mjs'), 'utf8');
    const installSmokeLinux = readFileSync(resolve(process.cwd(), 'scripts/smoke/install-smoke-linux.mjs'), 'utf8');

    for (const content of [startupSmoke, releaseSmoke, installSmokeLinux]) {
      expect(content).toMatch(/openclaw(?:\\\/|\/)node_modules(?:\\\/|\/)@larksuiteoapi(?:\\\/|\/)node-sdk/);
    }
  });

  it('requires packaged startup smoke to wait for Gateway readiness', () => {
    const startupSmoke = readFileSync(resolve(process.cwd(), 'scripts/smoke/packaged-startup.mjs'), 'utf8');
    const mainProcess = readFileSync(resolve(process.cwd(), 'electron/main/index.ts'), 'utf8');

    expect(startupSmoke).toContain('KTCLAW_STARTUP_SMOKE_WAIT_FOR_GATEWAY');
    expect(startupSmoke).toContain('240_000');
    expect(startupSmoke).toContain('OPENCLAW_DISABLE_BONJOUR');
    expect(mainProcess).toContain('STARTUP_SMOKE_WAIT_FOR_GATEWAY');
    expect(mainProcess).toContain('startupSmokeRendererLoaded');
    expect(mainProcess).toContain('startupSmokeGatewayRunning');
    expect(mainProcess).toContain("startupSmokeController.pass('renderer-loaded-and-gateway-running')");
    expect(mainProcess).toContain("startupSmokeController.pass('did-finish-load')");
    expect(mainProcess).toContain('!STARTUP_SMOKE_WAIT_FOR_GATEWAY');
  });

  it('patches A2A utility package exports in plugin packaging paths', () => {
    const bundlePlugins = readFileSync(resolve(process.cwd(), 'scripts/bundle-openclaw-plugins.mjs'), 'utf8');
    const afterPack = readFileSync(resolve(process.cwd(), 'scripts/after-pack.cjs'), 'utf8');

    for (const content of [bundlePlugins, afterPack]) {
      expect(content).toContain('patchA2AUtilsPackageExports');
      expect(content).toContain('@a2anet');
      expect(content).toContain('a2a-utils');
      expect(content).toContain('rootExport.require');
    }
  });

  it('runs Playwright and Linux release/install smoke in the main CI workflow', () => {
    const checkWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/check.yml'), 'utf8');

    expect(checkWorkflow).toContain('playwright install');
    expect(checkWorkflow).toContain('pnpm run test:e2e');
    expect(checkWorkflow).toContain('pnpm run smoke:linux');
  });

  it('uses aligned CI packaging scripts in release workflows', () => {
    const releaseWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    const packageWinManualWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/package-win-manual.yml'), 'utf8');

    expect(releaseWorkflow).toContain('pnpm run package:mac:ci');
    expect(releaseWorkflow).toContain('pnpm run smoke:startup:packaged -- --platform=mac');
    expect(releaseWorkflow).toContain('pnpm run package:prepare');
    expect(releaseWorkflow).toContain('pnpm exec electron-builder --win --x64 --publish never');
    expect(releaseWorkflow).toContain('pnpm exec electron-builder --win --arm64 --publish never');
    expect(releaseWorkflow).toContain('pnpm run smoke:startup:packaged -- --platform=win');
    expect(releaseWorkflow).toContain('pnpm run package:linux:ci');
    expect(releaseWorkflow).toContain('pnpm run smoke:startup:packaged -- --platform=linux');
    expect(releaseWorkflow).toContain('pnpm run smoke:release:linux');
    expect(releaseWorkflow).toContain('pnpm run smoke:install:linux');

    expect(packageWinManualWorkflow).toContain('pnpm run package:prepare');
    expect(packageWinManualWorkflow).toContain('pnpm exec electron-builder --win --x64 --publish never');
    expect(packageWinManualWorkflow).toContain('pnpm exec electron-builder --win --arm64 --publish never');
  });
});
