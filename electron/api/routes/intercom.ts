import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  deleteIntercomRoute,
  getIntercomSnapshot,
  installIntercomProtocol,
  sendIntercomMessage,
  upsertIntercomRoute,
  type IntercomRouteInput,
  type IntercomSendInput,
} from '../../services/intercom';

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
      sendJson(res, 202, await sendIntercomMessage(body));
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
