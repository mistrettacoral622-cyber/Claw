import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listAgentsSnapshot } from '../utils/agent-config';
import { readOpenClawConfig, writeOpenClawConfig, type OpenClawConfig } from '../utils/channel-config';
import { withConfigLock } from '../utils/config-mutex';
import { expandPath, getOpenClawDir, getOpenClawEntryPath } from '../utils/paths';
import { logger } from '../utils/logger';

export type IntercomTransport = 'local' | 'ssh' | 'nats';

export interface IntercomRoute {
  id: string;
  displayName: string;
  host: string;
  agent: string;
  transport: IntercomTransport;
  sessionId: string;
  enabled: boolean;
  sshUser?: string;
  sshPort?: number;
  remoteCommand?: string;
  source: 'config' | 'local';
}

export interface IntercomSnapshot {
  localHost: string;
  defaultSessionId: string;
  routes: IntercomRoute[];
  localAgents: Array<{ id: string; name: string }>;
}

export interface IntercomRouteInput {
  id?: string;
  displayName?: string;
  host?: string;
  agent?: string;
  transport?: IntercomTransport;
  sessionId?: string;
  enabled?: boolean;
  sshUser?: string;
  sshPort?: number | null;
  remoteCommand?: string;
}

export interface IntercomSendInput {
  target: string;
  sender: string;
  message: string;
  sessionId?: string;
}

export interface IntercomSendResult {
  success: true;
  queued: true;
  target: string;
  sender: string;
  transport: IntercomTransport;
  host: string;
  agent: string;
  sessionId: string;
  command: string;
  args: string[];
}

interface StoredIntercomConfig extends Record<string, unknown> {
  localHost?: string;
  defaultSessionId?: string;
  agents?: Record<string, Partial<IntercomRouteInput>>;
}

interface IntercomConfigDocument extends OpenClawConfig {
  intercom?: StoredIntercomConfig;
}

const DEFAULT_SESSION_ID = 'intercom';
const ROUTE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const INTERCOM_PROTOCOL_MARKER = 'KTClaw Intercom Protocol';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTransport(value: unknown): IntercomTransport {
  return value === 'ssh' || value === 'nats' ? value : 'local';
}

function normalizeRouteId(value: unknown): string {
  const id = normalizeString(value);
  if (!id || !ROUTE_ID_PATTERN.test(id)) {
    throw new Error('Intercom route id must use letters, numbers, dot, underscore, or dash');
  }
  return id;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function getStoredIntercomConfig(config: IntercomConfigDocument): StoredIntercomConfig {
  return config.intercom && typeof config.intercom === 'object' && !Array.isArray(config.intercom)
    ? config.intercom
    : {};
}

function getLocalHost(config: IntercomConfigDocument): string {
  return normalizeString(getStoredIntercomConfig(config).localHost) || hostname() || 'local';
}

function getDefaultSessionId(config: IntercomConfigDocument): string {
  return normalizeString(getStoredIntercomConfig(config).defaultSessionId) || DEFAULT_SESSION_ID;
}

function normalizeStoredRoute(
  id: string,
  value: Partial<IntercomRouteInput> | undefined,
  config: IntercomConfigDocument,
): IntercomRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const routeId = normalizeRouteId(id);
  const transport = normalizeTransport(value.transport);
  const agent = normalizeString(value.agent) || routeId;
  const host = normalizeString(value.host) || (transport === 'local' ? getLocalHost(config) : '');
  if (!host || !agent) {
    return null;
  }

  return {
    id: routeId,
    displayName: normalizeString(value.displayName) || routeId,
    host,
    agent,
    transport,
    sessionId: normalizeString(value.sessionId) || getDefaultSessionId(config),
    enabled: value.enabled !== false,
    sshUser: normalizeString(value.sshUser) || undefined,
    sshPort: normalizePositiveInteger(value.sshPort),
    remoteCommand: normalizeString(value.remoteCommand) || undefined,
    source: 'config',
  };
}

function normalizeRouteForStorage(input: IntercomRouteInput, config: IntercomConfigDocument): IntercomRoute {
  const id = normalizeRouteId(input.id);
  const transport = normalizeTransport(input.transport);
  const agent = normalizeString(input.agent) || id;
  const host = normalizeString(input.host) || (transport === 'local' ? getLocalHost(config) : '');
  if (!host) {
    throw new Error('host is required for intercom routes');
  }

  return {
    id,
    displayName: normalizeString(input.displayName) || id,
    host,
    agent,
    transport,
    sessionId: normalizeString(input.sessionId) || getDefaultSessionId(config),
    enabled: input.enabled !== false,
    sshUser: normalizeString(input.sshUser) || undefined,
    sshPort: normalizePositiveInteger(input.sshPort),
    remoteCommand: normalizeString(input.remoteCommand) || undefined,
    source: 'config',
  };
}

function toStoredRoute(route: IntercomRoute): Partial<IntercomRouteInput> {
  return {
    displayName: route.displayName,
    host: route.host,
    agent: route.agent,
    transport: route.transport,
    sessionId: route.sessionId,
    enabled: route.enabled,
    ...(route.sshUser ? { sshUser: route.sshUser } : {}),
    ...(route.sshPort ? { sshPort: route.sshPort } : {}),
    ...(route.remoteCommand ? { remoteCommand: route.remoteCommand } : {}),
  };
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCallerMessage(sender: string, message: string): string {
  return `[from agent ${sender}] ${message}`;
}

function buildLocalCommand(route: IntercomRoute, message: string, sessionId: string) {
  return {
    command: process.execPath,
    args: [
      getOpenClawEntryPath(),
      'agent',
      '--agent',
      route.agent,
      '--session-id',
      sessionId,
      '--message',
      message,
      '--json',
    ],
    cwd: getOpenClawDir(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_EMBEDDED_IN: 'KTClaw',
    },
  };
}

function buildSshCommand(route: IntercomRoute, message: string, sessionId: string) {
  const host = route.sshUser && !route.host.includes('@')
    ? `${route.sshUser}@${route.host}`
    : route.host;
  const remoteArgs = [
    'agent',
    '--agent',
    route.agent,
    '--session-id',
    sessionId,
    '--message',
    message,
    '--json',
  ];
  const openclawCommand = route.remoteCommand || 'openclaw';
  const remoteCommandPrefix = /[\s'"\\]/.test(openclawCommand)
    ? quotePosix(openclawCommand)
    : openclawCommand;
  const remoteCommand = `${remoteCommandPrefix} ${remoteArgs.map(quotePosix).join(' ')}`;
  return {
    command: 'ssh',
    args: [
      ...(route.sshPort ? ['-p', String(route.sshPort)] : []),
      host,
      remoteCommand,
    ],
    cwd: undefined,
    env: process.env,
  };
}

function spawnDetached(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (error) => {
    logger.warn('Failed to spawn intercom command', {
      command,
      error: String(error),
    });
  });
  child.unref();
}

function ensureIntercomConfig(config: IntercomConfigDocument): StoredIntercomConfig {
  const current = getStoredIntercomConfig(config);
  const next: StoredIntercomConfig = {
    ...current,
    defaultSessionId: normalizeString(current.defaultSessionId) || DEFAULT_SESSION_ID,
    localHost: normalizeString(current.localHost) || hostname() || 'local',
    agents: current.agents && typeof current.agents === 'object' && !Array.isArray(current.agents)
      ? { ...current.agents }
      : {},
  };
  config.intercom = next;
  return next;
}

export async function getIntercomSnapshot(): Promise<IntercomSnapshot> {
  const [config, agentsSnapshot] = await Promise.all([
    readOpenClawConfig() as Promise<IntercomConfigDocument>,
    listAgentsSnapshot(),
  ]);
  const intercom = getStoredIntercomConfig(config);
  const explicitAgents = intercom.agents && typeof intercom.agents === 'object' && !Array.isArray(intercom.agents)
    ? intercom.agents
    : {};
  const routesById = new Map<string, IntercomRoute>();

  for (const [id, value] of Object.entries(explicitAgents)) {
    const route = normalizeStoredRoute(id, value, config);
    if (route) {
      routesById.set(route.id, route);
    }
  }

  for (const agent of agentsSnapshot.agents) {
    if (routesById.has(agent.id)) {
      continue;
    }
    routesById.set(agent.id, {
      id: agent.id,
      displayName: agent.name || agent.id,
      host: getLocalHost(config),
      agent: agent.id,
      transport: 'local',
      sessionId: getDefaultSessionId(config),
      enabled: true,
      source: 'local',
    });
  }

  return {
    localHost: getLocalHost(config),
    defaultSessionId: getDefaultSessionId(config),
    localAgents: agentsSnapshot.agents.map((agent) => ({ id: agent.id, name: agent.name || agent.id })),
    routes: [...routesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function upsertIntercomRoute(input: IntercomRouteInput): Promise<IntercomSnapshot> {
  await withConfigLock(async () => {
    const config = await readOpenClawConfig() as IntercomConfigDocument;
    const route = normalizeRouteForStorage(input, config);
    const intercom = ensureIntercomConfig(config);
    intercom.agents = {
      ...(intercom.agents ?? {}),
      [route.id]: toStoredRoute(route),
    };
    await writeOpenClawConfig(config);
  });
  return getIntercomSnapshot();
}

export async function deleteIntercomRoute(routeId: string): Promise<IntercomSnapshot> {
  await withConfigLock(async () => {
    const config = await readOpenClawConfig() as IntercomConfigDocument;
    const intercom = ensureIntercomConfig(config);
    const id = normalizeRouteId(routeId);
    delete intercom.agents?.[id];
    await writeOpenClawConfig(config);
  });
  return getIntercomSnapshot();
}

export async function sendIntercomMessage(input: IntercomSendInput): Promise<IntercomSendResult> {
  const target = normalizeRouteId(input.target);
  const sender = normalizeString(input.sender) || 'ktclaw';
  const message = normalizeString(input.message);
  if (!message) {
    throw new Error('message is required');
  }

  const snapshot = await getIntercomSnapshot();
  const route = snapshot.routes.find((entry) => entry.id === target);
  if (!route) {
    throw new Error(`Intercom target not found: ${target}`);
  }
  if (!route.enabled) {
    throw new Error(`Intercom target is disabled: ${target}`);
  }
  if (route.transport === 'nats') {
    throw new Error('NATS intercom transport is not implemented yet');
  }

  const sessionId = normalizeString(input.sessionId) || route.sessionId || snapshot.defaultSessionId;
  const finalMessage = buildCallerMessage(sender, message);
  const invocation = route.transport === 'ssh'
    ? buildSshCommand(route, finalMessage, sessionId)
    : buildLocalCommand(route, finalMessage, sessionId);
  spawnDetached(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
  });

  return {
    success: true,
    queued: true,
    target,
    sender,
    transport: route.transport,
    host: route.host,
    agent: route.agent,
    sessionId,
    command: invocation.command,
    args: invocation.args,
  };
}

function buildProtocolBlock(): string {
  return `

## ${INTERCOM_PROTOCOL_MARKER}

You can page peer agents through KTClaw/OpenClaw intercom. When a message starts with \`[from agent <sender>]\`, treat it as an inter-agent request. Handle it promptly, then reply to the sender through the intercom route rather than only answering the human chat.

For local terminal use, send with:

\`\`\`bash
openclaw agent --agent <target-agent-id> --session-id intercom --message "[from agent <your-agent-id>] <message>"
\`\`\`

Avoid acknowledgement loops: if the message is only a simple receipt such as "received" or "ack", no reply is needed.
`;
}

export async function installIntercomProtocol(): Promise<{
  success: true;
  updated: string[];
  skipped: string[];
}> {
  const snapshot = await listAgentsSnapshot();
  const protocol = buildProtocolBlock();
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const agent of snapshot.agents) {
    if (!agent.workspace) {
      skipped.push(agent.id);
      continue;
    }

    const agentsMdPath = join(expandPath(agent.workspace), 'AGENTS.md');
    let content = '';
    try {
      content = await readFile(agentsMdPath, 'utf8');
    } catch {
      // Missing AGENTS.md is fine; create it below.
    }

    if (content.includes(INTERCOM_PROTOCOL_MARKER)) {
      skipped.push(agent.id);
      continue;
    }

    await mkdir(dirname(agentsMdPath), { recursive: true });
    await writeFile(agentsMdPath, `${content.trimEnd()}${protocol}\n`, 'utf8');
    updated.push(agent.id);
  }

  return { success: true, updated, skipped };
}
