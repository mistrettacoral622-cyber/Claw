import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { desktopCapturer, screen } from 'electron';
import { logger } from '../utils/logger';
import type { IntercomDesktopScreenshotRequest } from '../../shared/intercom-desktop-screenshot';

const INTERCOM_DESKTOP_SCREENSHOT_REQUEST_DIR = join(homedir(), '.ktclaw', 'intercom', 'desktop-screenshot-requests');
const INTERCOM_OUTBOX_MARKER = '/.ktclaw/intercom/outbox/';

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

function expandIntercomPath(value: string): string {
  const normalized = normalizeRemotePath(value);
  if (normalized.startsWith('~/')) {
    return join(homedir(), normalized.slice(2));
  }
  return normalized;
}

function isIntercomOutboxPath(value: string): boolean {
  const normalized = normalizeRemotePath(value).toLowerCase();
  return normalized.startsWith('~/.ktclaw/intercom/outbox/')
    || normalized.includes(INTERCOM_OUTBOX_MARKER);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeScreenshotRequest(value: unknown): IntercomDesktopScreenshotRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const requestId = readString(row.requestId);
  const taskId = readString(row.taskId);
  const artifactPath = normalizeRemotePath(readString(row.artifactPath));
  const acceptedPath = normalizeRemotePath(readString(row.acceptedPath));
  const resultPath = normalizeRemotePath(readString(row.resultPath));
  if (!requestId || !taskId || !artifactPath || !resultPath) {
    return null;
  }
  if (!isIntercomOutboxPath(artifactPath)
    || !isIntercomOutboxPath(resultPath)
    || (acceptedPath && !isIntercomOutboxPath(acceptedPath))) {
    return null;
  }
  return {
    requestId,
    taskId,
    artifactPath,
    acceptedPath: acceptedPath || undefined,
    resultPath,
    reason: readString(row.reason) || undefined,
    requestedAt: typeof row.requestedAt === 'number' && Number.isFinite(row.requestedAt)
      ? row.requestedAt
      : Date.now(),
  };
}

async function writeDesktopScreenshotJson(path: string, payload: Record<string, unknown>): Promise<void> {
  const normalizedPath = normalizeRemotePath(path);
  if (!isIntercomOutboxPath(normalizedPath)) {
    throw new Error('desktop screenshot path must be under the intercom outbox');
  }
  const localPath = expandIntercomPath(normalizedPath);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, JSON.stringify(payload, null, 2), 'utf8');
}

async function acknowledgeIntercomDesktopScreenshotRequest(request: IntercomDesktopScreenshotRequest): Promise<void> {
  if (!request.acceptedPath) {
    return;
  }
  await writeDesktopScreenshotJson(request.acceptedPath, {
    success: true,
    requestId: request.requestId,
    taskId: request.taskId,
    acceptedAt: Date.now(),
  });
}

async function capturePrimaryScreenPng(): Promise<Buffer> {
  const primaryDisplay = screen.getPrimaryDisplay();
  const bounds = primaryDisplay.bounds;
  const scaleFactor = primaryDisplay.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.max(1, Math.round(bounds.width * scaleFactor)),
    height: Math.max(1, Math.round(bounds.height * scaleFactor)),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
    fetchWindowIcons: false,
  });
  const primaryDisplayId = String(primaryDisplay.id);
  const source = sources.find((entry) => entry.display_id === primaryDisplayId) ?? sources[0];
  if (!source) {
    throw new Error('No desktop screen source is available');
  }
  const png = source.thumbnail.toPNG();
  if (png.length === 0) {
    throw new Error('Desktop screenshot capture returned an empty image');
  }
  return png;
}

async function completeIntercomDesktopScreenshotRequest(request: IntercomDesktopScreenshotRequest): Promise<void> {
  try {
    await acknowledgeIntercomDesktopScreenshotRequest(request);
    const png = await capturePrimaryScreenPng();
    const localArtifactPath = expandIntercomPath(request.artifactPath);
    await mkdir(dirname(localArtifactPath), { recursive: true });
    await writeFile(localArtifactPath, png);
    await writeDesktopScreenshotJson(request.resultPath, {
      success: true,
      summary: 'Screenshot captured by KTClaw desktop.',
      artifacts: [
        {
          type: 'image',
          path: request.artifactPath,
          name: basename(request.artifactPath) || 'screenshot.png',
          mimeType: 'image/png',
          size: png.length,
        },
      ],
      logs: 'Captured through KTClaw desktop screenshot request.',
      error: null,
    });
  } catch (error) {
    await writeDesktopScreenshotJson(request.resultPath, {
      success: false,
      summary: '',
      artifacts: [],
      logs: 'KTClaw desktop screenshot capture failed.',
      error: error instanceof Error ? error.message : String(error),
    }).catch((writeError) => {
      logger.warn('Failed to write intercom desktop screenshot failure result', {
        requestId: request.requestId,
        error: String(writeError),
      });
    });
  }
}

export function startIntercomDesktopScreenshotRequestWatcher(): () => void {
  let watcher: FSWatcher | null = null;
  let stopped = false;
  const seen = new Set<string>();

  const processFile = async (fileName: string) => {
    if (stopped || !fileName.endsWith('.json') || seen.has(fileName)) {
      return;
    }
    const filePath = join(INTERCOM_DESKTOP_SCREENSHOT_REQUEST_DIR, fileName);
    try {
      const raw = await readFile(filePath, 'utf8');
      const request = normalizeScreenshotRequest(JSON.parse(raw));
      seen.add(fileName);
      await rm(filePath, { force: true });
      if (request) {
        await completeIntercomDesktopScreenshotRequest(request);
      }
    } catch (error) {
      logger.warn('Failed to process intercom desktop screenshot request', {
        fileName,
        error: String(error),
      });
    }
  };

  const scan = async () => {
    try {
      await mkdir(INTERCOM_DESKTOP_SCREENSHOT_REQUEST_DIR, { recursive: true });
      const files = await readdir(INTERCOM_DESKTOP_SCREENSHOT_REQUEST_DIR);
      await Promise.all(files.map(processFile));
    } catch (error) {
      logger.warn('Failed to scan intercom desktop screenshot requests', { error: String(error) });
    }
  };

  void scan();
  void mkdir(INTERCOM_DESKTOP_SCREENSHOT_REQUEST_DIR, { recursive: true }).then(() => {
    if (stopped) {
      return;
    }
    watcher = watch(INTERCOM_DESKTOP_SCREENSHOT_REQUEST_DIR, (_eventType, fileName) => {
      if (typeof fileName === 'string') {
        void processFile(fileName);
      } else {
        void scan();
      }
    });
  }).catch((error) => {
    logger.warn('Failed to start intercom desktop screenshot watcher', { error: String(error) });
  });

  return () => {
    stopped = true;
    watcher?.close();
  };
}
