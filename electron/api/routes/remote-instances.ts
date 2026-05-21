import type { IncomingMessage, ServerResponse } from 'http';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { PORTS } from '../../utils/config';
import {
  generateA2AInboundApiKeyInOpenClaw,
  getA2APluginConfigFromOpenClaw,
  getGatewayExposureConfigFromOpenClaw,
  revokeA2AInboundApiKeyInOpenClaw,
  updateA2AInboundConfigInOpenClaw,
  updateGatewayExposureConfigInOpenClaw,
  type A2AInboundAgentCardConfig,
  type A2APluginConfigSnapshot,
  type OpenClawGatewayExposureConfigSnapshot,
} from '../../utils/openclaw-auth';
import {
  createRemoteInstance,
  deleteRemoteInstance,
  getRemoteInstance,
  listRemoteInstances,
  updateRemoteInstance,
  type RemoteAgentCardSnapshot,
  type RemoteInstanceHeaderAuth,
} from '../../services/remote-instances/config';
import { fetchAgentCard } from '../../services/remote-instances/agent-card';
import {
  getRemoteInstanceTask,
  sendRemoteInstanceMessage,
  syncRemoteInstancesToA2APlugin,
  testRemoteInstanceConnection,
} from '../../services/remote-instances/a2a-runtime';

type CreateRemoteInstanceBody = {
  displayName?: string;
  agentCardUrl?: string;
  auth?: Partial<RemoteInstanceHeaderAuth>;
  authMode?: RemoteInstanceHeaderAuth['mode'];
  bearerToken?: string | null;
  headers?: Record<string, string>;
};

type UpdateRemoteInstanceBody = {
  displayName?: string;
  agentCardUrl?: string;
  auth?: Partial<RemoteInstanceHeaderAuth>;
  authMode?: RemoteInstanceHeaderAuth['mode'];
  bearerToken?: string | null;
  headers?: Record<string, string>;
  agentCard?: RemoteAgentCardSnapshot | null;
};

type SendRemoteInstanceMessageBody = {
  message?: string;
  content?: string;
  context_id?: string | null;
  contextId?: string | null;
  task_id?: string | null;
  taskId?: string | null;
  attachToTask?: boolean;
  timeout?: number;
  data?: unknown[];
  files?: string[];
};

type UpdateSelfInboundBody = {
  enabled?: boolean;
  agentCard?: A2AInboundAgentCardConfig;
  agentCardName?: string;
  agentCardDescription?: string;
  allowUnauthenticated?: boolean;
  networkMode?: 'local' | 'lan';
};

type GenerateSelfAccessKeyBody = {
  label?: string;
};

function normalizeIdFromPath(pathname: string, suffix = ''): string | null {
  const base = pathname.slice('/api/remote-instances/'.length);
  const raw = suffix && base.endsWith(suffix)
    ? base.slice(0, -suffix.length)
    : base;
  const normalized = raw.replace(/\/+$/, '').trim();
  return normalized ? decodeURIComponent(normalized) : null;
}

function normalizeAgentCardUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function normalizeUnknownList(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizePatchString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function maskSecret(value: string): string {
  if (value.length <= 12) {
    return '*'.repeat(Math.max(value.length, 4));
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function parseIpv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets as [number, number, number, number]
    : null;
}

function isPrivateLanIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return false;
  }

  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isReservedOrVirtualIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return true;
  }

  const [first, second] = octets;
  return first === 0
    || first === 127
    || (first === 169 && second === 254)
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function scoreInterfaceName(name: string): number {
  const normalized = name.toLowerCase();
  const virtualMarkers = [
    'docker',
    'hyper-v',
    'loopback',
    'meta',
    'tailscale',
    'utun',
    'vbox',
    'virtual',
    'vmware',
    'wsl',
    'zerotier',
  ];
  if (virtualMarkers.some((marker) => normalized.includes(marker))) {
    return -50;
  }

  const preferredMarkers = ['ethernet', 'wi-fi', 'wifi', 'wlan', 'wireless'];
  if (preferredMarkers.some((marker) => normalized.includes(marker))) {
    return 20;
  }

  return /^(en|eth)\d*/.test(normalized) ? 10 : 0;
}

function scoreLanIpv4Candidate(name: string, address: string): number {
  if (isReservedOrVirtualIpv4(address)) {
    return Number.NEGATIVE_INFINITY;
  }

  return (isPrivateLanIpv4(address) ? 100 : 10) + scoreInterfaceName(name);
}

export function selectBestLanIpv4Address(interfaces: ReturnType<typeof networkInterfaces>): string | null {
  const candidates: Array<{ address: string; score: number; index: number }> = [];
  let index = 0;

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const info = entry as NetworkInterfaceInfo;
      if (info.family === 'IPv4' && !info.internal && info.address) {
        const score = scoreLanIpv4Candidate(name, info.address);
        if (Number.isFinite(score)) {
          candidates.push({ address: info.address, score, index });
        }
        index += 1;
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  return candidates[0]?.address ?? null;
}

function getFirstLanIpv4Address(): string | null {
  return selectBestLanIpv4Address(networkInterfaces());
}

function buildInboundUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

function buildRemoteInstanceSelfPayload(
  snapshot: A2APluginConfigSnapshot,
  exposure: OpenClawGatewayExposureConfigSnapshot,
  ctx: HostApiContext,
  newAccessKey?: { label: string; key: string },
  reloadRequested = false,
) {
  const gatewayStatus = ctx.gatewayManager.getStatus();
  const port = gatewayStatus.port || PORTS.OPENCLAW_GATEWAY;
  const localBaseUrl = `http://127.0.0.1:${port}`;
  const lanAddress = getFirstLanIpv4Address();
  const lanBaseUrl = lanAddress ? `http://${lanAddress}:${port}` : null;
  const localAgentCardUrl = buildInboundUrl(localBaseUrl, '/.well-known/agent-card.json');
  const localA2AEndpointUrl = buildInboundUrl(localBaseUrl, '/a2a');
  const lanAgentCardUrl = lanBaseUrl ? buildInboundUrl(lanBaseUrl, '/.well-known/agent-card.json') : null;
  const lanA2AEndpointUrl = lanBaseUrl ? buildInboundUrl(lanBaseUrl, '/a2a') : null;
  const shareUrl = exposure.bindMode === 'lan' && lanAgentCardUrl ? lanAgentCardUrl : localAgentCardUrl;
  const networkMode = exposure.bindMode === 'lan' ? 'lan' : 'local';
  const lanHint = !lanBaseUrl
    ? 'No LAN IPv4 address was detected. Connect to a local network or use Tailscale/VPN.'
    : exposure.bindMode === 'lan'
      ? `LAN sharing is enabled. Devices on the same network can use: ${lanBaseUrl}`
      : `LAN URL is detected but Gateway is still local-only. Switch network access to LAN before sharing: ${lanBaseUrl}`;

  return {
    success: true,
    self: {
      enabled: snapshot.enabled,
      gateway: {
        state: gatewayStatus.state,
        port,
      },
      network: {
        mode: networkMode,
        bindMode: exposure.bindMode,
        tailscaleMode: exposure.tailscaleMode,
        customBindHost: exposure.customBindHost ?? null,
        externallyReachable: exposure.bindMode === 'lan',
        requiresFirewall: exposure.bindMode === 'lan',
      },
      inbound: {
        agentCard: snapshot.inbound.agentCard ?? {},
        allowUnauthenticated: snapshot.inbound.allowUnauthenticated === true,
        apiKeys: (snapshot.inbound.apiKeys ?? []).map((apiKey) => ({
          label: apiKey.label,
          maskedKey: maskSecret(apiKey.key),
        })),
      },
      urls: {
        localAgentCardUrl,
        localA2AEndpointUrl,
        lanAgentCardUrl,
        lanA2AEndpointUrl,
        tailscaleAgentCardUrlHint: `https://<your-tailnet-host>/.well-known/agent-card.json`,
        tailscaleA2AEndpointUrlHint: `https://<your-tailnet-host>/a2a`,
      },
      share: {
        url: shareUrl,
        headerName: 'Authorization',
        headerValueExample: newAccessKey ? `Bearer ${newAccessKey.key}` : 'Bearer <access-key>',
        headerLineExample: newAccessKey ? `Authorization: Bearer ${newAccessKey.key}` : 'Authorization: Bearer <access-key>',
      },
      newAccessKey: newAccessKey
        ? {
            label: newAccessKey.label,
            key: newAccessKey.key,
            header: `Authorization: Bearer ${newAccessKey.key}`,
          }
        : null,
      hints: {
        lan: lanHint,
        tailscale: 'For remote sharing, use a Tailscale MagicDNS/Serve/Funnel URL and keep the /a2a and /.well-known/agent-card.json paths.',
      },
      reloadRequested,
    },
  };
}

function buildSelfInboundPatch(body: UpdateSelfInboundBody) {
  const agentCardInput = body.agentCard && typeof body.agentCard === 'object' && !Array.isArray(body.agentCard)
    ? body.agentCard as Record<string, unknown>
    : {};
  const agentCard: A2AInboundAgentCardConfig = {};
  const rawName = agentCardInput.name ?? body.agentCardName;
  const rawDescription = agentCardInput.description ?? body.agentCardDescription;

  if (typeof rawName === 'string') {
    agentCard.name = rawName.trim();
  }
  if (typeof rawDescription === 'string') {
    agentCard.description = rawDescription.trim();
  }
  if (Array.isArray(agentCardInput.skills)) {
    agentCard.skills = agentCardInput.skills as A2AInboundAgentCardConfig['skills'];
  }

  return {
    enabled: normalizeBoolean(body.enabled),
    ...(Object.keys(agentCard).length > 0 ? { agentCard } : {}),
    allowUnauthenticated: normalizeBoolean(body.allowUnauthenticated),
  };
}

function buildSelfNetworkPatch(body: UpdateSelfInboundBody) {
  if (body.networkMode === 'lan') {
    return { bindMode: 'lan' as const };
  }

  if (body.networkMode === 'local') {
    return { bindMode: 'loopback' as const };
  }

  return null;
}

function buildDefaultAccessKeyLabel(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `shared-${stamp}`;
}

function hasSelfAccessKeyPrefix(pathname: string): boolean {
  return pathname.startsWith('/api/remote-instances/self/api-keys/');
}

function parseSelfAccessKeyPath(pathname: string): string | null {
  const prefix = '/api/remote-instances/self/api-keys/';
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const encodedLabel = pathname.slice(prefix.length).replace(/\/+$/, '').trim();
  return encodedLabel ? decodeURIComponent(encodedLabel) : null;
}

function requestGatewayRefresh(ctx: HostApiContext, options?: { restart?: boolean }): void {
  if (options?.restart && typeof ctx.gatewayManager.debouncedRestart === 'function') {
    ctx.gatewayManager.debouncedRestart(500);
    return;
  }

  if (typeof ctx.gatewayManager.debouncedReload === 'function') {
    ctx.gatewayManager.debouncedReload(500);
  } else if (typeof ctx.gatewayManager.debouncedRestart === 'function') {
    ctx.gatewayManager.debouncedRestart(500);
  }
}

function normalizeAuthInput(value: unknown): Partial<RemoteInstanceHeaderAuth> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const container = value as Record<string, unknown>;
  const auth = container.auth && typeof container.auth === 'object' && !Array.isArray(container.auth)
    ? container.auth as Record<string, unknown>
    : container;
  const rawHeaders = auth.headers ?? container.headers;
  const headers = rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)
    ? Object.fromEntries(
      Object.entries(rawHeaders as Record<string, unknown>)
        .map(([key, rawValue]) => [key.trim(), typeof rawValue === 'string' ? rawValue.trim() : ''])
        .filter(([key, rawValue]) => key && rawValue),
    )
    : undefined;
  const mode = auth.mode ?? container.authMode;
  const token = auth.token ?? auth.bearerToken ?? container.bearerToken;

  return {
    mode: mode === 'bearer' || mode === 'headers' || mode === 'mixed' || mode === 'none'
      ? mode
      : undefined,
    token: typeof token === 'string' ? token.trim() : undefined,
    headers,
  };
}

function parseConversationMessagesPath(pathname: string): string | null {
  if (!pathname.endsWith('/conversation/messages')) {
    return null;
  }
  return normalizeIdFromPath(pathname, '/conversation/messages');
}

function parseConversationTaskPath(pathname: string): { instanceId: string; taskId: string } | null {
  const prefix = '/api/remote-instances/';
  const marker = '/conversation/tasks/';
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const tail = pathname.slice(prefix.length);
  const markerIndex = tail.indexOf(marker);
  if (markerIndex <= 0) {
    return null;
  }

  const encodedInstanceId = tail.slice(0, markerIndex).trim();
  const encodedTaskId = tail.slice(markerIndex + marker.length).replace(/\/+$/, '').trim();
  if (!encodedInstanceId || !encodedTaskId) {
    return null;
  }

  return {
    instanceId: decodeURIComponent(encodedInstanceId),
    taskId: decodeURIComponent(encodedTaskId),
  };
}

function buildConnectionTestPayload(input: {
  success: boolean;
  message?: string;
  latencyMs?: number;
  httpStatus?: number;
  checkedAt: string;
  instance?: unknown;
  result?: unknown;
  error?: string;
}) {
  return {
    success: input.success,
    ok: input.success,
    status: input.success ? 'ok' : 'error',
    message: input.message ?? input.error ?? null,
    checkedAt: input.checkedAt,
    latencyMs: input.latencyMs,
    httpStatus: input.httpStatus,
    ...(input.instance ? { instance: input.instance } : {}),
    ...(input.result ? { result: input.result } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function buildConversationPayload(
  instanceId: string,
  result: Awaited<ReturnType<typeof sendRemoteInstanceMessage>>,
) {
  return {
    success: true,
    instanceId,
    conversation: {
      context_id: result.context_id,
      contextId: result.contextId,
      task_id: result.task_id,
      taskId: result.taskId,
      state: result.state,
      status: result.status,
    },
    message: result.message,
    messages: result.messages,
    runtime: {
      tool: result.tool,
      agent_id: result.agent_id,
      agentId: result.agentId,
      context_id: result.context_id,
      contextId: result.contextId,
      task_id: result.task_id,
      taskId: result.taskId,
      state: result.state,
      status: result.status,
      artifacts: result.artifacts,
      raw: result.raw,
    },
    raw: result.raw,
  };
}

async function syncAllRemoteInstancesToRuntime(): Promise<void> {
  const instances = await listRemoteInstances();
  await syncRemoteInstancesToA2APlugin(instances);
}

async function refreshRemoteInstanceAgentCard(instanceId: string) {
  const instance = await getRemoteInstance(instanceId);
  if (!instance) {
    return { status: 404, payload: { success: false, error: 'Remote instance not found' } };
  }

  try {
    const fetched = await fetchAgentCard({
      url: instance.agentCardUrl,
      auth: instance.auth,
    });
    const updated = await updateRemoteInstance(instance.id, {
      displayName: instance.displayName,
      agentCard: fetched.agentCard,
      health: {
        status: 'ok',
        testedAt: new Date().toISOString(),
        latencyMs: fetched.latencyMs,
        httpStatus: fetched.httpStatus,
        message: 'Agent Card fetched successfully',
      },
    });

    if (updated) {
      await syncAllRemoteInstancesToRuntime();
    }

    return {
      status: 200,
      payload: {
        success: true,
        instance: updated,
      },
    };
  } catch (error) {
    await updateRemoteInstance(instance.id, {
      health: {
        status: 'error',
        testedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      status: 502,
      payload: {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function testRemoteInstance(instanceId: string) {
  const instance = await getRemoteInstance(instanceId);
  if (!instance) {
    return { status: 404, payload: { success: false, error: 'Remote instance not found' } };
  }

  try {
    const fetched = await fetchAgentCard({
      url: instance.agentCardUrl,
      auth: instance.auth,
    });
    const refreshed = await updateRemoteInstance(instance.id, {
      agentCard: fetched.agentCard,
    });
    const targetInstance = refreshed ?? instance;
    const result = await testRemoteInstanceConnection(targetInstance, {
      latencyMs: fetched.latencyMs,
      httpStatus: fetched.httpStatus,
    });

    const checkedAt = new Date().toISOString();
    const health = {
      status: result.success ? 'ok' : 'error',
      testedAt: checkedAt,
      latencyMs: result.latencyMs,
      httpStatus: result.httpStatus,
      message: result.message,
    } as const;

    const updated = await updateRemoteInstance(instance.id, {
      agentCard: fetched.agentCard,
      health,
    });

    return {
      status: result.success ? 200 : 502,
      payload: buildConnectionTestPayload({
        success: result.success,
        message: result.message,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
        checkedAt,
        instance: updated,
        result,
      }),
    };
  } catch (error) {
    const checkedAt = new Date().toISOString();
    const updated = await updateRemoteInstance(instance.id, {
      health: {
        status: 'error',
        testedAt: checkedAt,
        message: error instanceof Error ? error.message : String(error),
      },
    });

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 502,
      payload: buildConnectionTestPayload({
        success: false,
        error: errorMessage,
        checkedAt,
        instance: updated,
        result: {
          success: false,
          message: errorMessage,
          runtimeSynced: false,
        },
      }),
    };
  }
}

async function sendConversationMessage(instanceId: string, req: IncomingMessage) {
  const instance = await getRemoteInstance(instanceId);
  if (!instance) {
    return { status: 404, payload: { success: false, error: 'Remote instance not found' } };
  }

  const body = await parseJsonBody<SendRemoteInstanceMessageBody>(req);
  const message = normalizeOptionalString(body.message) ?? normalizeOptionalString(body.content);
  if (!message) {
    return { status: 400, payload: { success: false, error: 'message is required' } };
  }

  const result = await sendRemoteInstanceMessage(instance, {
    message,
    contextId: normalizeOptionalString(body.context_id) ?? normalizeOptionalString(body.contextId),
    taskId: body.attachToTask === true
      ? normalizeOptionalString(body.task_id) ?? normalizeOptionalString(body.taskId)
      : undefined,
    timeout: normalizePositiveNumber(body.timeout),
    data: normalizeUnknownList(body.data),
    files: normalizeStringList(body.files),
  });

  return {
    status: 200,
    payload: buildConversationPayload(instance.id, result),
  };
}

async function refreshConversationTask(
  instanceId: string,
  taskId: string,
  url: URL,
) {
  const instance = await getRemoteInstance(instanceId);
  if (!instance) {
    return { status: 404, payload: { success: false, error: 'Remote instance not found' } };
  }

  const normalizedTaskId = normalizeOptionalString(taskId);
  if (!normalizedTaskId) {
    return { status: 400, payload: { success: false, error: 'taskId is required' } };
  }

  const result = await getRemoteInstanceTask(instance, {
    taskId: normalizedTaskId,
    timeout: normalizePositiveNumber(Number(url.searchParams.get('timeout'))),
    pollInterval: normalizePositiveNumber(Number(url.searchParams.get('pollInterval') ?? url.searchParams.get('poll_interval'))),
  });

  return {
    status: 200,
    payload: buildConversationPayload(instance.id, result),
  };
}

export async function handleRemoteInstanceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/remote-instances' && req.method === 'GET') {
    const instances = await listRemoteInstances();
    sendJson(res, 200, {
      success: true,
      items: instances,
      instances,
    });
    return true;
  }

  if (url.pathname === '/api/remote-instances' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<CreateRemoteInstanceBody>(req);
      const agentCardUrl = normalizeAgentCardUrl(body.agentCardUrl);
      if (!agentCardUrl) {
        sendJson(res, 400, { success: false, error: 'agentCardUrl is required' });
        return true;
      }

      const auth = normalizeAuthInput(body);
      const fetched = await fetchAgentCard({
        url: agentCardUrl,
        auth,
      });

      const instance = await createRemoteInstance({
        displayName: body.displayName || fetched.agentCard.name,
        agentCardUrl,
        auth,
        agentCard: fetched.agentCard,
        health: {
          status: 'ok',
          testedAt: new Date().toISOString(),
          latencyMs: fetched.latencyMs,
          httpStatus: fetched.httpStatus,
          message: 'Agent Card fetched successfully',
        },
      });

      await syncAllRemoteInstancesToRuntime();
      sendJson(res, 201, { success: true, instance });
    } catch (error) {
      sendJson(res, 502, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/remote-instances/self' && req.method === 'GET') {
    try {
      const snapshot = await getA2APluginConfigFromOpenClaw();
      const exposure = await getGatewayExposureConfigFromOpenClaw();
      sendJson(res, 200, buildRemoteInstanceSelfPayload(snapshot, exposure, ctx));
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (
    url.pathname === '/api/remote-instances/self' &&
    (req.method === 'PUT' || req.method === 'PATCH')
  ) {
    try {
      const body = await parseJsonBody<UpdateSelfInboundBody>(req);
      const snapshot = await updateA2AInboundConfigInOpenClaw(buildSelfInboundPatch(body));
      const networkPatch = buildSelfNetworkPatch(body);
      const exposure = networkPatch
        ? await updateGatewayExposureConfigInOpenClaw(networkPatch)
        : await getGatewayExposureConfigFromOpenClaw();
      requestGatewayRefresh(ctx, { restart: networkPatch != null });
      sendJson(res, 200, buildRemoteInstanceSelfPayload(snapshot, exposure, ctx, undefined, true));
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/remote-instances/self/api-keys' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<GenerateSelfAccessKeyBody>(req);
      const label = normalizePatchString(body.label) || buildDefaultAccessKeyLabel();
      const result = await generateA2AInboundApiKeyInOpenClaw(label);
      requestGatewayRefresh(ctx, { restart: true });
      const exposure = await getGatewayExposureConfigFromOpenClaw();
      sendJson(
        res,
        201,
        buildRemoteInstanceSelfPayload(result.snapshot, exposure, ctx, result.apiKey, true),
      );
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (hasSelfAccessKeyPrefix(url.pathname) && req.method === 'DELETE') {
    const label = parseSelfAccessKeyPath(url.pathname);
    if (!label) {
      sendJson(res, 400, { success: false, error: 'Invalid access key label' });
      return true;
    }

    try {
      const result = await revokeA2AInboundApiKeyInOpenClaw(label);
      if (!result.revoked) {
        sendJson(res, 404, { success: false, error: 'A2A inbound key not found' });
        return true;
      }

      requestGatewayRefresh(ctx, { restart: true });
      const exposure = await getGatewayExposureConfigFromOpenClaw();
      sendJson(res, 200, buildRemoteInstanceSelfPayload(result.snapshot, exposure, ctx, undefined, true));
    } catch (error) {
      sendJson(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/remote-instances/') && req.method === 'POST') {
    const instanceId = parseConversationMessagesPath(url.pathname);
    if (instanceId) {
      try {
        const result = await sendConversationMessage(instanceId, req);
        sendJson(res, result.status, result.payload);
      } catch (error) {
        sendJson(res, 502, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
  }

  if (url.pathname.startsWith('/api/remote-instances/') && req.method === 'GET') {
    const taskPath = parseConversationTaskPath(url.pathname);
    if (taskPath) {
      try {
        const result = await refreshConversationTask(taskPath.instanceId, taskPath.taskId, url);
        sendJson(res, result.status, result.payload);
      } catch (error) {
        sendJson(res, 502, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
  }

  if (
    url.pathname.startsWith('/api/remote-instances/') &&
    (req.method === 'PUT' || req.method === 'PATCH') &&
    !url.pathname.endsWith('/refresh') &&
    !url.pathname.endsWith('/agent-card/refresh') &&
    !url.pathname.endsWith('/test')
  ) {
    const instanceId = normalizeIdFromPath(url.pathname);
    if (!instanceId) {
      sendJson(res, 400, { success: false, error: 'Invalid remote instance id' });
      return true;
    }

    try {
      const body = await parseJsonBody<UpdateRemoteInstanceBody>(req);
      const updated = await updateRemoteInstance(instanceId, {
        displayName: body.displayName,
        agentCardUrl: body.agentCardUrl ? normalizeAgentCardUrl(body.agentCardUrl) : undefined,
        auth: normalizeAuthInput(body),
        agentCard: body.agentCard,
      });

      if (!updated) {
        sendJson(res, 404, { success: false, error: 'Remote instance not found' });
        return true;
      }

      await syncAllRemoteInstancesToRuntime();
      sendJson(res, 200, { success: true, instance: updated });
    } catch (error) {
      sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/remote-instances/') && req.method === 'DELETE') {
    const instanceId = normalizeIdFromPath(url.pathname);
    if (!instanceId) {
      sendJson(res, 400, { success: false, error: 'Invalid remote instance id' });
      return true;
    }

    const deleted = await deleteRemoteInstance(instanceId);
    if (!deleted) {
      sendJson(res, 404, { success: false, error: 'Remote instance not found' });
      return true;
    }

    await syncAllRemoteInstancesToRuntime();
    sendJson(res, 200, { success: true });
    return true;
  }

  if (
    (url.pathname.endsWith('/refresh') || url.pathname.endsWith('/agent-card/refresh')) &&
    req.method === 'POST'
  ) {
    const suffix = url.pathname.endsWith('/agent-card/refresh') ? '/agent-card/refresh' : '/refresh';
    const instanceId = normalizeIdFromPath(url.pathname, suffix);
    if (!instanceId) {
      sendJson(res, 400, { success: false, error: 'Invalid remote instance id' });
      return true;
    }

    const result = await refreshRemoteInstanceAgentCard(instanceId);
    sendJson(res, result.status, result.payload);
    return true;
  }

  if (url.pathname.endsWith('/test') && req.method === 'POST') {
    const instanceId = normalizeIdFromPath(url.pathname, '/test');
    if (!instanceId) {
      sendJson(res, 400, { success: false, error: 'Invalid remote instance id' });
      return true;
    }

    const result = await testRemoteInstance(instanceId);
    sendJson(res, result.status, result.payload);
    return true;
  }

  return false;
}
