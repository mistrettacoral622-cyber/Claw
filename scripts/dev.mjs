#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const viteBin = path.resolve(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');

function exitWithChild(child) {
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (process.platform === 'win32') {
  const ps = process.execPath.replace(/'/g, "''");
  const vb = viteBin.replace(/'/g, "''");
  const command = [
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "chcp 65001 > $null",
    `& '${ps}' '${vb}'`,
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  exitWithChild(child);
} else {
  const child = spawn(process.execPath, [viteBin], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });
  exitWithChild(child);
}
