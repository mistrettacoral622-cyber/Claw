import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PORTS } from '../utils/config';
import { logger } from '../utils/logger';
import type { HostApiContext } from './context';
import { isAuthorizedHostApiRequest, applyCorsOrigin, sendJson, sendNoContent, sendUnauthorized } from './route-utils';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
) => Promise<boolean>;

type LazyRouteDefinition = {
  prefixes: string[];
  loader: () => Promise<RouteHandler>;
};

const routeHandlerCache = new Map<string, Promise<RouteHandler>>();

function memoizeRouteLoader(cacheKey: string, loader: () => Promise<RouteHandler>): () => Promise<RouteHandler> {
  return async () => {
    const cached = routeHandlerCache.get(cacheKey);
    if (cached) {
      return await cached;
    }

    const loadPromise = loader();
    routeHandlerCache.set(cacheKey, loadPromise);
    return await loadPromise;
  };
}

const routeDefinitions: LazyRouteDefinition[] = [
  { prefixes: ['/api/app'], loader: memoizeRouteLoader('app', () => import('./routes/app').then((mod) => mod.handleAppRoutes)) },
  { prefixes: ['/api/gateway', '/api/chat'], loader: memoizeRouteLoader('gateway', () => import('./routes/gateway').then((mod) => mod.handleGatewayRoutes)) },
  { prefixes: ['/api/settings'], loader: memoizeRouteLoader('settings', () => import('./routes/settings').then((mod) => mod.handleSettingsRoutes)) },
  { prefixes: ['/api/provider-accounts', '/api/providers', '/api/provider-vendors'], loader: memoizeRouteLoader('providers', () => import('./routes/providers').then((mod) => mod.handleProviderRoutes)) },
  { prefixes: ['/api/agents'], loader: memoizeRouteLoader('agents', () => import('./routes/agents').then((mod) => mod.handleAgentRoutes)) },
  { prefixes: ['/api/teams'], loader: memoizeRouteLoader('teams', () => import('./routes/teams').then((mod) => mod.handleTeamRoutes)) },
  { prefixes: ['/api/tasks'], loader: memoizeRouteLoader('tasks', () => import('./routes/tasks').then((mod) => mod.handleTaskRoutes)) },
  { prefixes: ['/api/channels'], loader: memoizeRouteLoader('channels', () => import('./routes/channels').then((mod) => mod.handleChannelRoutes)) },
  { prefixes: ['/api/intercom'], loader: memoizeRouteLoader('intercom', () => import('./routes/intercom').then((mod) => mod.handleIntercomRoutes)) },
  { prefixes: ['/api/remote-instances'], loader: memoizeRouteLoader('remote-instances', () => import('./routes/remote-instances').then((mod) => mod.handleRemoteInstanceRoutes)) },
  { prefixes: ['/api/skills'], loader: memoizeRouteLoader('skills', () => import('./routes/skills').then((mod) => mod.handleSkillRoutes)) },
  { prefixes: ['/api/files'], loader: memoizeRouteLoader('files', () => import('./routes/files').then((mod) => mod.handleFileRoutes)) },
  { prefixes: ['/api/image-generation'], loader: memoizeRouteLoader('image-generation', () => import('./routes/image-generation').then((mod) => mod.handleImageGenerationRoutes)) },
  { prefixes: ['/api/image-search'], loader: memoizeRouteLoader('image-search', () => import('./routes/image-search').then((mod) => mod.handleImageSearchRoutes)) },
  { prefixes: ['/api/sessions'], loader: memoizeRouteLoader('sessions', () => import('./routes/sessions').then((mod) => mod.handleSessionRoutes)) },
  { prefixes: ['/api/cron'], loader: memoizeRouteLoader('cron', () => import('./routes/cron').then((mod) => mod.handleCronRoutes)) },
  { prefixes: ['/api/approvals'], loader: memoizeRouteLoader('approvals', () => import('./routes/approvals').then((mod) => mod.handleApprovalRoutes)) },
  { prefixes: ['/api/health'], loader: memoizeRouteLoader('health', () => import('./routes/health').then((mod) => mod.handleHealthRoutes)) },
  { prefixes: ['/api/memory'], loader: memoizeRouteLoader('memory', () => import('./routes/memory').then((mod) => mod.handleMemoryRoutes)) },
  { prefixes: ['/api/local-embeddings-runtime'], loader: memoizeRouteLoader('local-embeddings-runtime', () => import('./routes/local-embeddings-runtime').then((mod) => mod.handleLocalEmbeddingsRuntimeRoutes)) },
  { prefixes: ['/api/mcp'], loader: memoizeRouteLoader('mcp', () => import('./routes/mcp').then((mod) => mod.handleMcpRoutes)) },
  { prefixes: ['/api/costs'], loader: memoizeRouteLoader('costs', () => import('./routes/costs').then((mod) => mod.handleCostsRoutes)) },
  { prefixes: ['/api/alerts'], loader: memoizeRouteLoader('alerts', () => import('./routes/alerts').then((mod) => mod.handleAlertsRoutes)) },
  { prefixes: ['/api/feishu'], loader: memoizeRouteLoader('feishu', () => import('./routes/feishu').then((mod) => mod.handleFeishuRoutes)) },
  { prefixes: ['/api/logs'], loader: memoizeRouteLoader('logs', () => import('./routes/logs').then((mod) => mod.handleLogRoutes)) },
  { prefixes: ['/api/usage'], loader: memoizeRouteLoader('usage', () => import('./routes/usage').then((mod) => mod.handleUsageRoutes)) },
  { prefixes: ['/api/backup'], loader: memoizeRouteLoader('backup', () => import('./routes/backup').then((mod) => mod.handleBackupRoutes)) },
];

function getMatchingRouteDefinitions(pathname: string): LazyRouteDefinition[] {
  return routeDefinitions.filter((definition) =>
    definition.prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)));
}

/**
 * Per-session secret token used to authenticate Host API requests.
 * Generated once at server start and shared with the renderer via IPC.
 * This prevents cross-origin attackers from reading sensitive data even
 * if they can reach 127.0.0.1:3210 (the CORS wildcard alone is not
 * sufficient because browsers attach the Origin header but not a secret).
 */
let hostApiToken: string = '';

/** Retrieve the current Host API auth token (for use by IPC proxy). */
export function getHostApiToken(): string {
  return hostApiToken;
}

export function startHostApiServer(ctx: HostApiContext, port = PORTS.CLAWX_HOST_API): Server {
  // Generate a cryptographically random token for this session.
  hostApiToken = randomBytes(32).toString('hex');

  const server = createServer(async (req, res) => {
    try {
      // Apply CORS origin restriction before any response is sent.
      applyCorsOrigin(req, res);
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (req.method === 'OPTIONS') {
        sendNoContent(res);
        return;
      }
      if (!isAuthorizedHostApiRequest(req, ctx.hostApiSessionToken)) {
        sendUnauthorized(res);
        return;
      }
      const matchingDefinitions = getMatchingRouteDefinitions(requestUrl.pathname);
      for (const definition of matchingDefinitions) {
        const handler = await definition.loader();
        if (await handler(req, res, requestUrl, ctx)) {
          return;
        }
      }
      sendJson(res, 404, { success: false, error: `No route for ${req.method} ${requestUrl.pathname}` });
    } catch (error) {
      logger.error('Host API request failed:', error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`Host API server listening on http://127.0.0.1:${port}`);
  });

  return server;
}
