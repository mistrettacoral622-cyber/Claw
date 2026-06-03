import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  deleteIntercomRoute,
  downloadIntercomArtifacts,
  getIntercomHostReadiness,
  getIntercomSnapshot,
  installIntercomProtocol,
  pollIntercomMessage,
  prepareIntercomHost,
  sendIntercomMessage,
  sendIntercomTask,
  setIntercomHostAccess,
  upsertIntercomRoute,
  uploadIntercomFiles,
  type IntercomDownloadArtifactsInput,
  type IntercomPollInput,
  type IntercomRouteInput,
  type IntercomRemoteTaskSendInput,
  type IntercomSendInput,
  type IntercomUploadFilesInput,
} from '../../services/intercom';
import {
  completeIntercomDesktopCameraRequest,
  failIntercomDesktopCameraRequest,
} from '../../services/intercom-desktop-camera';
import type {
  IntercomDesktopCameraCompleteInput,
  IntercomDesktopCameraFailInput,
} from '../../../shared/intercom-desktop-camera';

function parseIntercomRouteId(pathname: string, suffix = ''): string | null {
  const prefix = '/api/intercom/routes/';
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const raw = pathname.slice(prefix.length);
  const withoutSuffix = suffix && raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw;
  const routeId = withoutSuffix.replace(/\/+$/, '').trim();
  return routeId ? decodeURIComponent(routeId) : null;
}

function sendIntercomCommandError(res: ServerResponse, error: unknown): void {
  const row = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  sendJson(res, 502, {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    exitCode: typeof row.exitCode === 'number' ? row.exitCode : null,
    stdout: typeof row.stdout === 'string' ? row.stdout : '',
    stderr: typeof row.stderr === 'string' ? row.stderr : '',
    durationMs: typeof row.durationMs === 'number' ? row.durationMs : null,
  });
}

function assertString(value: unknown, field: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
}

function assertArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} is required`);
  }
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} is required`);
  }
}

export async function handleIntercomRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/intercom' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, ...(await getIntercomSnapshot()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/intercom/host-readiness' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, ...(await getIntercomHostReadiness()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/intercom/prepare-host' && req.method === 'POST') {
    try {
      sendJson(res, 200, await prepareIntercomHost());
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/intercom/host-access' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ enabled?: unknown }>(req);
      assertBoolean(body.enabled, 'enabled');
      sendJson(res, 200, await setIntercomHostAccess(body.enabled));
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/intercom/routes' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<IntercomRouteInput>(req);
      sendJson(res, 200, { success: true, ...(await upsertIntercomRoute(body)) });
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/intercom/routes/') && req.method === 'DELETE') {
    try {
      const routeId = parseIntercomRouteId(url.pathname);
      if (!routeId) {
        sendJson(res, 400, { success: false, error: 'Invalid intercom route id' });
        return true;
      }
      sendJson(res, 200, { success: true, ...(await deleteIntercomRoute(routeId)) });
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/intercom/send' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<IntercomSendInput>(req);
      sendJson(res, 200, await sendIntercomMessage(body));
    } catch (error) {
      sendIntercomCommandError(res, error);
    }
    return true;
  }

  if (url.pathname === '/api/intercom/poll' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<IntercomPollInput>(req);
      assertString(body.target, 'target');
      sendJson(res, 200, await pollIntercomMessage(body));
    } catch (error) {
      sendIntercomCommandError(res, error);
    }
    return true;
  }

  if (url.pathname === '/api/intercom/tasks' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<IntercomRemoteTaskSendInput>(req);
      assertString(body.target, 'target');
      assertString(body.sender, 'sender');
      assertString(body.action, 'action');
      sendJson(res, 200, await sendIntercomTask(body));
    } catch (error) {
      sendIntercomCommandError(res, error);
    }
    return true;
  }

  if (url.pathname === '/api/intercom/desktop-camera/complete' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<IntercomDesktopCameraCompleteInput>(req);
      assertString(body.requestId, 'requestId');
      assertString(body.taskId, 'taskId');
      assertString(body.artifactPath, 'artifactPath');
      assertString(body.resultPath, 'resultPath');
      assertString(body.base64, 'base64');
      sendJson(res, 200, await completeIntercomDesktopCameraRequest(body));
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/intercom/desktop-camera/fail' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<IntercomDesktopCameraFailInput>(req);
      assertString(body.requestId, 'requestId');
      assertString(body.taskId, 'taskId');
      assertString(body.artifactPath, 'artifactPath');
      assertString(body.resultPath, 'resultPath');
      assertString(body.error, 'error');
      sendJson(res, 200, await failIntercomDesktopCameraRequest(body));
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/intercom/transfers/upload' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<IntercomUploadFilesInput>(req);
      assertString(body.target, 'target');
      assertString(body.sender, 'sender');
      assertString(body.taskId, 'taskId');
      assertArray(body.files, 'files');
      sendJson(res, 200, await uploadIntercomFiles(body));
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/intercom/transfers/download' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<IntercomDownloadArtifactsInput>(req);
      assertString(body.target, 'target');
      assertString(body.taskId, 'taskId');
      assertArray(body.artifacts, 'artifacts');
      sendJson(res, 200, await downloadIntercomArtifacts(body));
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/intercom/install-protocol' && req.method === 'POST') {
    try {
      sendJson(res, 200, await installIntercomProtocol());
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
