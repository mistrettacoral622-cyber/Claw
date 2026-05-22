import { spawn } from 'node:child_process';
import { hostname, networkInterfaces, userInfo, type NetworkInterfaceInfo } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client, type ConnectConfig } from 'ssh2';
import { listAgentsSnapshot } from '../utils/agent-config';
import { readOpenClawConfig, writeOpenClawConfig, type OpenClawConfig } from '../utils/channel-config';
import { withConfigLock } from '../utils/config-mutex';
import { expandPath, getOpenClawDir, getOpenClawEntryPath } from '../utils/paths';
import { logger } from '../utils/logger';
import { deleteProviderSecret, getProviderSecret, setProviderSecret } from './secrets/secret-store';

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
  sshPasswordConfigured?: boolean;
  remoteCommand?: string;
  source: 'config' | 'local';
}

export interface IntercomSnapshot {
  localHost: string;
  defaultSessionId: string;
  routes: IntercomRoute[];
  localAgents: Array<{ id: string; name: string }>;
  selfConfig: IntercomSelfConfig;
}

export interface IntercomSelfConfig {
  host: string;
  sshUser: string | null;
  sshPort: number;
  agentId: string;
  sessionId: string;
  remoteCommand: string;
  routeIdExample: string;
  displayNameExample: string;
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
  sshPassword?: string;
  clearSshPassword?: boolean;
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
  queued: false;
  target: string;
  sender: string;
  transport: IntercomTransport;
  host: string;
  agent: string;
  sessionId: string;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
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
const SSH_CONNECT_TIMEOUT_SECONDS = 10;
const INTERCOM_COMMAND_TIMEOUT_MS = 60_000;
const INTERCOM_SSH_SECRET_PREFIX = 'intercom:ssh:';

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

function getIntercomSshSecretId(routeId: string): string {
  return `${INTERCOM_SSH_SECRET_PREFIX}${routeId}`;
}

function readSecretString(secret: Awaited<ReturnType<typeof getProviderSecret>>): string | null {
  if (!secret || !('apiKey' in secret) || typeof secret.apiKey !== 'string') {
    return null;
  }
  return secret.apiKey;
}

async function getIntercomSshPassword(routeId: string): Promise<string | null> {
  return readSecretString(await getProviderSecret(getIntercomSshSecretId(routeId)));
}

async function hasIntercomSshPassword(routeId: string): Promise<boolean> {
  return (await getIntercomSshPassword(routeId)) !== null;
}

async function updateIntercomSshPassword(routeId: string, input: IntercomRouteInput): Promise<void> {
  const secretId = getIntercomSshSecretId(routeId);
  if (input.clearSshPassword) {
    await deleteProviderSecret(secretId);
    return;
  }
  if (typeof input.sshPassword === 'string' && input.sshPassword.length > 0) {
    await setProviderSecret({
      type: 'local',
      accountId: secretId,
      apiKey: input.sshPassword,
    });
  }
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
    'vethernet',
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

export function selectBestIntercomLanIpv4Address(interfaces: ReturnType<typeof networkInterfaces>): string | null {
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

function getShareHostForSsh(config: IntercomConfigDocument): string {
  return selectBestIntercomLanIpv4Address(networkInterfaces()) || getLocalHost(config);
}

function getLocalSshUser(): string | null {
  try {
    return normalizeString(userInfo().username) || null;
  } catch {
    return null;
  }
}

function buildSelfConfig(
  config: IntercomConfigDocument,
  localAgents: Array<{ id: string; name: string }>,
): IntercomSelfConfig {
  const localHost = getLocalHost(config);
  const shareHost = getShareHostForSsh(config);
  const agent = localAgents[0] ?? { id: 'main', name: 'Main' };
  return {
    host: shareHost,
    sshUser: getLocalSshUser(),
    sshPort: 22,
    agentId: agent.id,
    sessionId: getDefaultSessionId(config),
    remoteCommand: 'openclaw',
    routeIdExample: `${shareHost}-${agent.id}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || agent.id,
    displayNameExample: `${hostname() || localHost} / ${agent.name || agent.id}`,
  };
}

function normalizeStoredRoute(
  id: string,
  value: Partial<IntercomRouteInput> | undefined,
  config: IntercomConfigDocument,
  passwordConfigured = false,
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
    sshPasswordConfigured: passwordConfigured,
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
    sshPasswordConfigured: false,
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

function resolveSshHostAndUsername(route: IntercomRoute): { host: string; username?: string } {
  if (route.sshUser || !route.host.includes('@')) {
    return {
      host: route.host,
      username: route.sshUser,
    };
  }
  const [username, ...hostParts] = route.host.split('@');
  return {
    host: hostParts.join('@') || route.host,
    username: username || undefined,
  };
}

function buildRemoteCommand(route: IntercomRoute, message: string, sessionId: string): string {
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
  return `${remoteCommandPrefix} ${remoteArgs.map(quotePosix).join(' ')}`;
}

function buildSshCommand(route: IntercomRoute, message: string, sessionId: string) {
  const resolved = resolveSshHostAndUsername(route);
  const host = resolved.username ? `${resolved.username}@${resolved.host}` : resolved.host;
  return {
    command: 'ssh',
    args: [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
      '-o',
      'ConnectionAttempts=1',
      '-o',
      'NumberOfPasswordPrompts=0',
      ...(route.sshPort ? ['-p', String(route.sshPort)] : []),
      host,
      buildRemoteCommand(route, message, sessionId),
    ],
    cwd: undefined,
    env: process.env,
  };
}

function runSsh2Command(route: IntercomRoute, password: string, message: string, sessionId: string) {
  const startedAt = Date.now();
  const resolved = resolveSshHostAndUsername(route);
  const username = resolved.username || userInfo().username;
  const remoteCommand = buildRemoteCommand(route, message, sessionId);
  const connectionConfig: ConnectConfig = {
    host: resolved.host,
    port: route.sshPort ?? 22,
    username,
    password,
    readyTimeout: SSH_CONNECT_TIMEOUT_SECONDS * 1000,
    timeout: SSH_CONNECT_TIMEOUT_SECONDS * 1000,
    tryKeyboard: true,
  };

  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number }>((resolve, reject) => {
    const client = new Client();
    let completed = false;
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;

    const finish = (callback: () => void) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      client.end();
      callback();
    };
    const buildResult = () => ({
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
    });
    const timeout = setTimeout(() => {
      const result = buildResult();
      const message = `Intercom SSH command timed out after ${Math.round(INTERCOM_COMMAND_TIMEOUT_MS / 1000)}s`;
      const error = new Error(`${message}. Check whether the remote OpenClaw command exits.`);
      Object.assign(error, {
        ...result,
        stderr: result.stderr || message,
      });
      logger.warn('Intercom SSH2 command timed out', {
        host: resolved.host,
        durationMs: result.durationMs,
      });
      finish(() => reject(error));
    }, INTERCOM_COMMAND_TIMEOUT_MS);

    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, done) => {
      done(prompts.map(() => password));
    });
    client.on('error', (error) => {
      logger.warn('Failed to run intercom SSH2 command', {
        host: resolved.host,
        error: String(error),
      });
      const result = buildResult();
      Object.assign(error, {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr || error.message,
        durationMs: result.durationMs,
      });
      finish(() => reject(error));
    });
    client.on('ready', () => {
      client.exec(remoteCommand, (error, channel) => {
        if (error) {
          const result = buildResult();
          Object.assign(error, {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr || error.message,
            durationMs: result.durationMs,
          });
          finish(() => reject(error));
          return;
        }
        channel.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        channel.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        channel.on('exit', (code: number | null) => {
          exitCode = code;
        });
        channel.on('close', () => {
          const result = buildResult();
          if (result.exitCode && result.exitCode !== 0) {
            const details = result.stderr || result.stdout || `exit code ${result.exitCode}`;
            const commandError = new Error(`Intercom command failed: ${details}`);
            Object.assign(commandError, result);
            finish(() => reject(commandError));
            return;
          }
          finish(() => resolve(result));
        });
      });
    });
    client.connect(connectionConfig);
  });
}

function runIntercomCommand(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let completed = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const finish = (callback: () => void) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      callback();
    };
    const buildResult = (exitCode: number | null) => ({
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
    });
    const timeout = setTimeout(() => {
      const result = buildResult(null);
      const message = `Intercom command timed out after ${Math.round(INTERCOM_COMMAND_TIMEOUT_MS / 1000)}s`;
      const error = new Error(`${message}. Check SSH key authentication and whether the remote OpenClaw command exits.`);
      Object.assign(error, {
        ...result,
        stderr: result.stderr || message,
      });
      logger.warn('Intercom command timed out', {
        command,
        durationMs: result.durationMs,
      });
      child.kill();
      finish(() => reject(error));
    }, INTERCOM_COMMAND_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      logger.warn('Failed to run intercom command', {
        command,
        error: String(error),
      });
      finish(() => reject(error));
    });
    child.on('close', (exitCode) => {
      const result = buildResult(exitCode);
      if (exitCode && exitCode !== 0) {
        const details = result.stderr || result.stdout || `exit code ${exitCode}`;
        const error = new Error(`Intercom command failed: ${details}`);
        Object.assign(error, result);
        finish(() => reject(error));
        return;
      }
      finish(() => resolve(result));
    });
  });
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
    const route = normalizeStoredRoute(id, value, config, await hasIntercomSshPassword(id));
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

  const localAgents = agentsSnapshot.agents.map((agent) => ({ id: agent.id, name: agent.name || agent.id }));

  return {
    localHost: getLocalHost(config),
    defaultSessionId: getDefaultSessionId(config),
    localAgents,
    selfConfig: buildSelfConfig(config, localAgents),
    routes: [...routesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function upsertIntercomRoute(input: IntercomRouteInput): Promise<IntercomSnapshot> {
  await withConfigLock(async () => {
    const config = await readOpenClawConfig() as IntercomConfigDocument;
    const route = normalizeRouteForStorage(input, config);
    await updateIntercomSshPassword(route.id, input);
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
    await deleteProviderSecret(getIntercomSshSecretId(id));
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
  const sshPassword = route.transport === 'ssh' ? await getIntercomSshPassword(route.id) : null;
  const invocation = route.transport === 'ssh' && sshPassword
    ? {
        command: 'ssh2',
        args: [
          `${resolveSshHostAndUsername(route).username || userInfo().username}@${resolveSshHostAndUsername(route).host}`,
          buildRemoteCommand(route, finalMessage, sessionId),
        ],
      }
    : route.transport === 'ssh'
      ? buildSshCommand(route, finalMessage, sessionId)
      : buildLocalCommand(route, finalMessage, sessionId);
  const commandResult = route.transport === 'ssh' && sshPassword
    ? await runSsh2Command(route, sshPassword, finalMessage, sessionId)
    : await runIntercomCommand(invocation.command, invocation.args, {
        cwd: 'cwd' in invocation ? invocation.cwd : undefined,
        env: 'env' in invocation ? invocation.env : process.env,
      });

  return {
    success: true,
    queued: false,
    target,
    sender,
    transport: route.transport,
    host: route.host,
    agent: route.agent,
    sessionId,
    command: invocation.command,
    args: invocation.args,
    exitCode: commandResult.exitCode,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    durationMs: commandResult.durationMs,
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
