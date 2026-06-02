import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { logger } from '../utils/logger';
import type {
  IntercomDesktopCameraCompleteInput,
  IntercomDesktopCameraFailInput,
  IntercomDesktopCameraRequest,
} from '../../shared/intercom-desktop-camera';

const INTERCOM_DESKTOP_CAMERA_REQUEST_DIR = join(homedir(), '.ktclaw', 'intercom', 'desktop-camera-requests');
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

function normalizeCameraRequest(value: unknown): IntercomDesktopCameraRequest | null {
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

async function writeDesktopCameraResult(resultPath: string, payload: Record<string, unknown>): Promise<void> {
  const normalizedResultPath = normalizeRemotePath(resultPath);
  if (!isIntercomOutboxPath(normalizedResultPath)) {
    throw new Error('desktop camera result path must be under the intercom outbox');
  }
  const localResultPath = expandIntercomPath(normalizedResultPath);
  await mkdir(dirname(localResultPath), { recursive: true });
  await writeFile(localResultPath, JSON.stringify(payload, null, 2), 'utf8');
}

export function getIntercomDesktopCameraRequestDir(): string {
  return INTERCOM_DESKTOP_CAMERA_REQUEST_DIR;
}

async function acknowledgeIntercomDesktopCameraRequest(request: IntercomDesktopCameraRequest): Promise<void> {
  if (!request.acceptedPath) {
    return;
  }
  await writeDesktopCameraResult(request.acceptedPath, {
    success: true,
    requestId: request.requestId,
    taskId: request.taskId,
    acceptedAt: Date.now(),
  });
}

export async function completeIntercomDesktopCameraRequest(input: IntercomDesktopCameraCompleteInput): Promise<{
  success: true;
  artifactPath: string;
  resultPath: string;
}> {
  const artifactPath = normalizeRemotePath(readString(input.artifactPath));
  const resultPath = normalizeRemotePath(readString(input.resultPath));
  if (!readString(input.requestId) || !readString(input.taskId)) {
    throw new Error('desktop camera request id and task id are required');
  }
  if (!artifactPath || !resultPath || !isIntercomOutboxPath(artifactPath) || !isIntercomOutboxPath(resultPath)) {
    throw new Error('desktop camera paths must be under the intercom outbox');
  }
  const buffer = Buffer.from(readString(input.base64), 'base64');
  if (buffer.length === 0) {
    throw new Error('desktop camera image payload is empty');
  }
  const mimeType = readString(input.mimeType) || 'image/jpeg';
  const localArtifactPath = expandIntercomPath(artifactPath);
  await mkdir(dirname(localArtifactPath), { recursive: true });
  await writeFile(localArtifactPath, buffer);
  await writeDesktopCameraResult(resultPath, {
    success: true,
    summary: 'Camera photo captured by KTClaw desktop.',
    artifacts: [
      {
        type: 'image',
        path: artifactPath,
        name: readString(input.fileName) || basename(artifactPath),
        mimeType,
        size: buffer.length,
      },
    ],
    logs: 'Captured through KTClaw desktop camera UI.',
    error: null,
  });
  return { success: true, artifactPath, resultPath };
}

export async function failIntercomDesktopCameraRequest(input: IntercomDesktopCameraFailInput): Promise<{ success: true }> {
  const error = readString(input.error) || 'Desktop camera request was cancelled.';
  await writeDesktopCameraResult(input.resultPath, {
    success: false,
    summary: '',
    artifacts: [],
    logs: 'KTClaw desktop camera UI did not return a photo.',
    error,
  });
  return { success: true };
}

export function startIntercomDesktopCameraRequestWatcher(
  onRequest: (request: IntercomDesktopCameraRequest) => void,
): () => void {
  let watcher: FSWatcher | null = null;
  let stopped = false;
  const seen = new Set<string>();

  const processFile = async (fileName: string) => {
    if (stopped || !fileName.endsWith('.json') || seen.has(fileName)) {
      return;
    }
    const filePath = join(INTERCOM_DESKTOP_CAMERA_REQUEST_DIR, fileName);
    try {
      const raw = await readFile(filePath, 'utf8');
      const request = normalizeCameraRequest(JSON.parse(raw));
      seen.add(fileName);
      await rm(filePath, { force: true });
      if (request) {
        await acknowledgeIntercomDesktopCameraRequest(request).catch((error) => {
          logger.warn('Failed to acknowledge intercom desktop camera request', {
            fileName,
            error: String(error),
          });
        });
        onRequest(request);
      }
    } catch (error) {
      logger.warn('Failed to process intercom desktop camera request', {
        fileName,
        error: String(error),
      });
    }
  };

  const scan = async () => {
    try {
      await mkdir(INTERCOM_DESKTOP_CAMERA_REQUEST_DIR, { recursive: true });
      const files = await readdir(INTERCOM_DESKTOP_CAMERA_REQUEST_DIR);
      await Promise.all(files.map(processFile));
    } catch (error) {
      logger.warn('Failed to scan intercom desktop camera requests', { error: String(error) });
    }
  };

  void scan();
  void mkdir(INTERCOM_DESKTOP_CAMERA_REQUEST_DIR, { recursive: true }).then(() => {
    if (stopped) {
      return;
    }
    watcher = watch(INTERCOM_DESKTOP_CAMERA_REQUEST_DIR, (_eventType, fileName) => {
      if (typeof fileName === 'string') {
        void processFile(fileName);
      } else {
        void scan();
      }
    });
  }).catch((error) => {
    logger.warn('Failed to start intercom desktop camera watcher', { error: String(error) });
  });

  return () => {
    stopped = true;
    watcher?.close();
  };
}
