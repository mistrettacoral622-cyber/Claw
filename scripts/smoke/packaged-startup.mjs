#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const cwd = process.cwd();
const args = new Map(
  process.argv.slice(2).filter((arg) => arg !== '--').map((arg) => {
    const [key, value = ''] = arg.split('=');
    return [key.replace(/^--/, ''), value];
  }),
);

const releaseDir = path.resolve(cwd, args.get('release-dir') || 'release');
const explicitExecutable = args.get('executable');
const platformArg = args.get('platform') || '';
const timeoutMs = Number.parseInt(args.get('timeout-ms') || '', 10) || 120_000;

function fail(message) {
  console.error(`[packaged-startup-smoke] FAIL: ${message}`);
  process.exit(1);
}

function normalizePlatform(raw) {
  if (raw === 'win32' || raw === 'win') return 'win';
  if (raw === 'darwin' || raw === 'mac' || raw === 'macos') return 'mac';
  if (raw === 'linux') return 'linux';
  fail(`unsupported platform: ${raw}`);
}

function walk(rootDir) {
  if (!existsSync(rootDir)) return [];
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function newest(paths) {
  const existing = paths.filter((file) => existsSync(file));
  return [...existing].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function findExecutable(platform, releaseRoot) {
  if (explicitExecutable) {
    const resolved = path.resolve(cwd, explicitExecutable);
    if (!existsSync(resolved)) {
      fail(`explicit executable not found: ${resolved}`);
    }
    return resolved;
  }

  if (!existsSync(releaseRoot)) {
    fail(`release directory not found: ${releaseRoot}`);
  }

  const files = walk(releaseRoot);
  if (platform === 'win') {
    const candidates = files.filter((file) => /win-unpacked[\\/](KTClaw|ktclaw)\.exe$/i.test(file));
    const target = newest(candidates);
    if (!target) fail(`no win-unpacked executable found under ${releaseRoot}`);
    return target;
  }

  if (platform === 'linux') {
    const candidates = files.filter((file) => /linux-unpacked[\\/](KTClaw|ktclaw)$/i.test(file));
    const target = newest(candidates);
    if (!target) fail(`no linux-unpacked executable found under ${releaseRoot}`);
    return target;
  }

  const candidates = files.filter((file) => /KTClaw\.app[\\/]Contents[\\/]MacOS[\\/]KTClaw$/i.test(file));
  const target = newest(candidates);
  if (!target) fail(`no macOS app executable found under ${releaseRoot}`);
  return target;
}

function resolveResourcesDir(platform, executable) {
  if (platform === 'mac') {
    return path.join(path.dirname(path.dirname(executable)), 'Resources');
  }

  return path.join(path.dirname(executable), 'resources');
}

function assertPackagedRuntimeResources(resourcesDir) {
  const required = [
    'openclaw/node_modules/@larksuiteoapi/node-sdk/package.json',
    'openclaw-plugins/a2a/openclaw.plugin.json',
    'openclaw-plugins/a2a/node_modules/@a2anet/a2a-utils/package.json',
    'openclaw-plugins/a2a/node_modules/@a2anet/a2a-utils/dist/index.js',
  ];

  for (const rel of required) {
    const fullPath = path.join(resourcesDir, ...rel.split('/'));
    if (!existsSync(fullPath)) {
      fail(`packaged runtime resource missing: ${fullPath}`);
    }
  }
}

function getLaunchArgs(platform) {
  if (platform !== 'linux') {
    return [];
  }

  // CI smoke runs the unpacked Electron binary before the Linux package
  // post-install script can set chrome-sandbox to root:4755. Without this,
  // Chromium aborts before the app reaches its startup smoke exit path.
  return ['--no-sandbox'];
}

async function main() {
  const platform = normalizePlatform(platformArg || process.platform);
  const executable = findExecutable(platform, releaseDir);
  assertPackagedRuntimeResources(resolveResourcesDir(platform, executable));
  const launchArgs = getLaunchArgs(platform);
  const child = spawn(executable, launchArgs, {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      CI: process.env.CI || '1',
      KTCLAW_STARTUP_SMOKE: '1',
      KTCLAW_STARTUP_SMOKE_WAIT_FOR_GATEWAY: '1',
      KTCLAW_STARTUP_SMOKE_TIMEOUT_MS: String(Math.max(15_000, timeoutMs - 5_000)),
      KTCLAW_LOG_TO_CONSOLE: '1',
      // GitHub macOS runners can expose a constrained mDNS environment where
      // @homebridge/ciao aborts during Bonjour probing. Startup smoke only
      // validates packaged app/Gateway readiness, so LAN discovery is noise here.
      OPENCLAW_DISABLE_BONJOUR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ code: null, signal: 'timeout' });
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: `spawn-error:${error.message}` });
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  if (result.code !== 0) {
    const stderrTail = stderr.split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
    const stdoutTail = stdout.split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
    fail(
      `startup smoke failed for ${executable} (code=${result.code}, signal=${result.signal})\nstdout:\n${stdoutTail}\nstderr:\n${stderrTail}`,
    );
  }

  console.log(`[packaged-startup-smoke] PASS: ${executable}`);
}

void main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});
