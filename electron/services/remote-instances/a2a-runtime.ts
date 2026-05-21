import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import { syncA2APluginConfigToOpenClaw } from '../../utils/openclaw-auth';
import { getOpenClawConfigDir } from '../../utils/paths';
import type {
  RemoteInstanceHeaderAuth,
  RemoteInstanceRecord,
} from './config';

export interface A2ARemoteRuntimeAgentConfig {
  url: string;
  custom_headers?: Record<string, string>;
}

export interface A2APluginOutboundConfig {
  agents: Record<string, A2ARemoteRuntimeAgentConfig>;
}

export interface RemoteInstanceConnectionTestResult {
  success: boolean;
  latencyMs?: number;
  httpStatus?: number;
  message?: string;
  runtimeSynced?: boolean;
}

export type RemoteInstanceRuntimeMessageRole = 'assistant' | 'user' | 'system' | 'tool';

export interface RemoteInstanceRuntimeMessage {
  id: string;
  role: RemoteInstanceRuntimeMessageRole;
  content: string;
  parts: unknown[];
  raw: unknown;
  createdAt: string;
}

export interface RemoteInstanceRuntimeSendInput {
  message: string;
  contextId?: string;
  taskId?: string;
  timeout?: number;
  data?: unknown[];
  files?: string[];
}

export interface RemoteInstanceRuntimeTaskInput {
  taskId: string;
  timeout?: number;
  pollInterval?: number;
}

export interface RemoteInstanceRuntimeResult {
  success: true;
  tool: 'a2a_send_message' | 'a2a_get_task';
  agent_id: string;
  agentId: string;
  context_id: string | null;
  contextId: string | null;
  task_id: string | null;
  taskId: string | null;
  state: string | null;
  status: unknown;
  message: RemoteInstanceRuntimeMessage | null;
  messages: RemoteInstanceRuntimeMessage[];
  artifacts: unknown[];
  raw: unknown;
}

type A2AToolResult = Record<string, unknown>;
type A2AUtilsModule = typeof import('@a2anet/a2a-utils');
type A2AToolsInstance = InstanceType<A2AUtilsModule['A2ATools']>;

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<A2AUtilsModule>;
let a2aUtilsModulePromise: Promise<A2AUtilsModule> | null = null;

export function resolvePackagedA2AUtilsSpecifier(options?: {
  isPackaged?: boolean;
  resourcesPath?: string;
}): string | null {
  const isPackaged = options?.isPackaged ?? app.isPackaged;
  if (!isPackaged) {
    return null;
  }

  const resourcesPath = options?.resourcesPath ?? process.resourcesPath;
  const candidates = [
    join(resourcesPath, 'openclaw-plugins', 'a2a', 'node_modules', '@a2anet', 'a2a-utils', 'dist', 'index.js'),
    join(resourcesPath, 'openclaw', 'node_modules', '@a2anet', 'a2a-utils', 'dist', 'index.js'),
  ];

  const entryPath = candidates.find((candidate) => existsSync(candidate));
  return entryPath ? pathToFileURL(entryPath).href : null;
}

function loadA2AUtils(): Promise<A2AUtilsModule> {
  a2aUtilsModulePromise ??= dynamicImport(resolvePackagedA2AUtilsSpecifier() ?? '@a2anet/a2a-utils');
  return a2aUtilsModulePromise;
}

function buildCustomHeaders(auth: RemoteInstanceHeaderAuth): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (key.trim() && value.trim()) {
      headers[key] = value;
    }
  }

  if ((auth.mode === 'bearer' || auth.mode === 'mixed') && auth.token?.trim()) {
    headers.Authorization = `Bearer ${auth.token.trim()}`;
  }

  return headers;
}

export function toA2AOutboundAgentConfig(instance: RemoteInstanceRecord): A2ARemoteRuntimeAgentConfig {
  const customHeaders = buildCustomHeaders(instance.auth);
  return {
    url: instance.agentCardUrl,
    ...(Object.keys(customHeaders).length > 0 ? { custom_headers: customHeaders } : {}),
  };
}

export function buildA2APluginOutboundConfig(instances: RemoteInstanceRecord[]): A2APluginOutboundConfig {
  const agents: Record<string, A2ARemoteRuntimeAgentConfig> = {};
  for (const instance of instances) {
    agents[instance.id] = toA2AOutboundAgentConfig(instance);
  }
  return { agents };
}

export async function syncRemoteInstancesToA2APlugin(instances: RemoteInstanceRecord[]): Promise<void> {
  await syncA2APluginConfigToOpenClaw(buildA2APluginOutboundConfig(instances));
}

export async function testRemoteInstanceConnection(
  instance: RemoteInstanceRecord,
  options?: { latencyMs?: number; httpStatus?: number },
): Promise<RemoteInstanceConnectionTestResult> {
  try {
    await syncRemoteInstancesToA2APlugin([instance]);

    return {
      success: true,
      latencyMs: options?.latencyMs,
      httpStatus: options?.httpStatus,
      message: 'Agent Card fetched and A2A plugin configuration synced',
      runtimeSynced: true,
    };
  } catch (error) {
    return {
      success: false,
      latencyMs: options?.latencyMs,
      httpStatus: options?.httpStatus,
      message: error instanceof Error ? error.message : String(error),
      runtimeSynced: false,
    };
  }
}

function normalizeRuntimeNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function extractString(source: unknown, keys: string[]): string | null {
  if (!source || typeof source !== 'object') {
    return null;
  }

  const row = source as Record<string, unknown>;
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function extractObject(source: unknown, key: string): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractArray(source: unknown, key: string): unknown[] {
  if (!source || typeof source !== 'object') {
    return [];
  }
  const value = (source as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function extractText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => extractText(item))
      .filter((item): item is string => Boolean(item))
      .join('\n')
      .trim();
    return text || null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }

  const row = value as Record<string, unknown>;
  const direct = extractString(row, ['text', 'content', 'message']);
  if (direct) {
    return direct;
  }
  return extractText(row.parts);
}

function normalizeRuntimeMessage(
  raw: unknown,
  fallbackId: string,
  createdAt: string,
): RemoteInstanceRuntimeMessage | null {
  if (!raw) {
    return null;
  }

  const row = typeof raw === 'object' && raw !== null
    ? raw as Record<string, unknown>
    : { content: raw };
  const content = extractText(row.parts) ?? extractText(row.content) ?? extractText(row.message) ?? extractText(raw);
  if (!content) {
    return null;
  }

  const rawRole = extractString(row, ['role'])?.toLowerCase();
  const role: RemoteInstanceRuntimeMessageRole = rawRole === 'user' || rawRole === 'system' || rawRole === 'tool'
    ? rawRole
    : 'assistant';

  return {
    id: extractString(row, ['id', 'messageId', 'message_id']) ?? fallbackId,
    role,
    content,
    parts: Array.isArray(row.parts) ? row.parts : [],
    raw,
    createdAt,
  };
}

function normalizeRuntimeResult(
  raw: A2AToolResult,
  tool: RemoteInstanceRuntimeResult['tool'],
  agentId: string,
): RemoteInstanceRuntimeResult {
  const status = extractObject(raw, 'status');
  const statusMessage = status?.message;
  const createdAt = new Date().toISOString();
  const contextId = extractString(raw, ['contextId', 'context_id'])
    ?? extractString(statusMessage, ['contextId', 'context_id']);
  const taskId = tool === 'a2a_get_task'
    ? extractString(raw, ['id', 'taskId', 'task_id'])
    : extractString(raw, ['id', 'taskId', 'task_id']);
  const state = extractString(status, ['state'])
    ?? extractString(raw, ['state', 'status']);
  const rootMessage = raw.kind === 'message'
    ? normalizeRuntimeMessage(raw, `${agentId}-${tool}-${createdAt}`, createdAt)
    : null;
  const taskMessage = normalizeRuntimeMessage(
    statusMessage,
    `${agentId}-${taskId ?? tool}-status-${createdAt}`,
    createdAt,
  );
  const messages = [rootMessage, taskMessage].filter((item): item is RemoteInstanceRuntimeMessage => item !== null);

  return {
    success: true,
    tool,
    agent_id: agentId,
    agentId,
    context_id: contextId,
    contextId,
    task_id: taskId,
    taskId,
    state,
    status: status ?? null,
    message: messages[0] ?? null,
    messages,
    artifacts: extractArray(raw, 'artifacts'),
    raw,
  };
}

function assertA2AToolSuccess(result: A2AToolResult): void {
  if (result.error !== true) {
    return;
  }
  const message = extractString(result, ['error_message', 'errorMessage', 'message'])
    ?? 'A2A runtime call failed';
  throw new Error(message);
}

function extractRuntimeAgentLoadError(result: unknown, agentId: string): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const row = result as Record<string, unknown>;
  if (row.error === true) {
    return extractString(row, ['error_message', 'errorMessage', 'message'])
      ?? 'A2A runtime failed to list agents';
  }

  const errors = extractObject(row, 'errors');
  const agentError = extractString(errors, [agentId]);
  if (agentError) {
    return agentError;
  }

  const agents = extractObject(row, 'agents') ?? row;
  if (Object.prototype.hasOwnProperty.call(agents, agentId)) {
    return null;
  }

  const available = Object.keys(agents)
    .filter((key) => key !== 'errors')
    .sort();
  return `A2A runtime did not load agent '${agentId}'. Available agents: ${available.length > 0 ? available.join(', ') : '(none)'}`;
}

async function assertA2ARuntimeAgentLoaded(
  tools: A2AToolsInstance,
  instance: RemoteInstanceRecord,
): Promise<void> {
  const result = await tools.getAgents.execute();
  const loadError = extractRuntimeAgentLoadError(result, instance.id);
  if (!loadError) {
    return;
  }

  throw new Error(
    `Failed to initialize remote agent '${instance.displayName || instance.id}' from ${instance.agentCardUrl}: ${loadError}`,
  );
}

async function createRemoteInstanceA2ATools(instance: RemoteInstanceRecord): Promise<A2AToolsInstance> {
  const {
    A2AAgents,
    A2ASession,
    A2ATools,
    ArtifactSettings,
    JSONTaskStore,
    LocalFileStore,
  } = await loadA2AUtils();
  const stateDir = getOpenClawConfigDir();
  const workspaceDir = join(stateDir, 'workspace');
  const agents = new A2AAgents({
    [instance.id]: toA2AOutboundAgentConfig(instance),
  });
  const session = new A2ASession(agents, {
    taskStore: new JSONTaskStore(join(stateDir, 'a2a', 'outbound', 'tasks')),
    fileStore: new LocalFileStore(join(workspaceDir, 'a2a', 'outbound', 'files')),
  });
  return new A2ATools(session, {
    artifactSettings: new ArtifactSettings(),
  });
}

export async function sendRemoteInstanceMessage(
  instance: RemoteInstanceRecord,
  input: RemoteInstanceRuntimeSendInput,
): Promise<RemoteInstanceRuntimeResult> {
  await syncRemoteInstancesToA2APlugin([instance]);
  const tools = await createRemoteInstanceA2ATools(instance);
  await assertA2ARuntimeAgentLoaded(tools, instance);
  const raw = await tools.sendMessage.execute({
    agentId: instance.id,
    message: input.message,
    contextId: input.contextId,
    taskId: input.taskId,
    timeout: normalizeRuntimeNumber(input.timeout),
    data: input.data,
    files: input.files,
  });
  assertA2AToolSuccess(raw);
  return normalizeRuntimeResult(raw, 'a2a_send_message', instance.id);
}

export async function getRemoteInstanceTask(
  instance: RemoteInstanceRecord,
  input: RemoteInstanceRuntimeTaskInput,
): Promise<RemoteInstanceRuntimeResult> {
  await syncRemoteInstancesToA2APlugin([instance]);
  const tools = await createRemoteInstanceA2ATools(instance);
  await assertA2ARuntimeAgentLoaded(tools, instance);
  const raw = await tools.getTask.execute({
    agentId: instance.id,
    taskId: input.taskId,
    timeout: normalizeRuntimeNumber(input.timeout),
    pollInterval: normalizeRuntimeNumber(input.pollInterval),
  });
  assertA2AToolSuccess(raw);
  return normalizeRuntimeResult(raw, 'a2a_get_task', instance.id);
}
