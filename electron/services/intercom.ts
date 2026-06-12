import { spawn } from 'node:child_process';
import { hostname, networkInterfaces, userInfo, type NetworkInterfaceInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix as pathPosix } from 'node:path';
import { Socket } from 'node:net';
import type { Client as Ssh2Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import { listAgentsSnapshot } from '../utils/agent-config';
import { readOpenClawConfig, writeOpenClawConfig, type OpenClawConfig } from '../utils/channel-config';
import { withConfigLock } from '../utils/config-mutex';
import { expandPath, getKTClawConfigDir, getOpenClawDir, getOpenClawEntryPath } from '../utils/paths';
import { logger } from '../utils/logger';
import { deleteProviderSecret, getProviderSecret, setProviderSecret } from './secrets/secret-store';
import { isTextOnlyImageSchemaError } from '../../shared/chat-media-attachments';

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
  remoteGatewayPort?: number;
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
  remoteGatewayPort: number;
  routeIdExample: string;
  displayNameExample: string;
}

export type IntercomHostReadinessStatus = 'ok' | 'warning' | 'missing' | 'unknown';

export interface IntercomHostReadinessCheck {
  id: 'lan-host' | 'ssh-user' | 'agent' | 'ssh-listener' | 'firewall' | 'remote-command';
  status: IntercomHostReadinessStatus;
  title: string;
  detail: string;
}

export interface IntercomHostReadiness {
  ready: boolean;
  accessEnabled: boolean;
  platform: NodeJS.Platform;
  canPrepare: boolean;
  needsAdmin: boolean;
  host: string;
  sshUser: string | null;
  sshPort: number;
  agentId: string;
  sessionId: string;
  remoteCommand: string;
  remoteGatewayPort: number;
  checks: IntercomHostReadinessCheck[];
  prepareCommandPreview: string | null;
}

export interface IntercomHostPrepareResult {
  success: boolean;
  started: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  status: IntercomHostReadiness;
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
  remoteGatewayPort?: number | null;
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
  pending?: boolean;
  poll?: {
    sessionId: string;
    beforeCount: number;
    status: 'running' | 'completed' | 'timeout_waiting_for_history';
  };
}

export interface IntercomPollInput {
  target: string;
  sessionId?: string;
  beforeCount?: number;
}

export type IntercomRemoteTaskReturnChannel = 'summary' | 'artifacts' | 'logs';

export interface IntercomRemoteTaskRequest {
  type: 'remote_task';
  taskId: string;
  action: string;
  payload: Record<string, unknown>;
  return: IntercomRemoteTaskReturnChannel[];
}

export interface IntercomRemoteTaskArtifact {
  type: 'file' | 'image' | 'directory' | 'archive' | 'text';
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface IntercomRemoteTaskResult {
  success: boolean;
  summary: string;
  artifacts: IntercomRemoteTaskArtifact[];
  logs: string;
  error: string | null;
}

export interface IntercomRemoteTaskSendInput {
  target: string;
  sender: string;
  action: string;
  payload?: Record<string, unknown>;
  taskId?: string;
  return?: IntercomRemoteTaskReturnChannel[];
  sessionId?: string;
}

export interface IntercomRemoteTaskSendResult extends Omit<IntercomSendResult, 'success'> {
  success: true;
  taskId: string;
  task: IntercomRemoteTaskRequest;
  result: IntercomRemoteTaskResult;
}

export type IntercomTransferDirection = 'upload' | 'download';
export type IntercomTransferStatus = 'queued' | 'running' | 'success' | 'error';

export interface IntercomTransferFileInput {
  localPath: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
}

export interface IntercomUploadFilesInput {
  target: string;
  sender: string;
  taskId: string;
  files: IntercomTransferFileInput[];
}

export interface IntercomDownloadArtifactInput {
  path: string;
  type?: IntercomRemoteTaskArtifact['type'];
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface IntercomDownloadArtifactsInput {
  target: string;
  taskId: string;
  artifacts: IntercomDownloadArtifactInput[];
}

export interface IntercomTransferRecord {
  id: string;
  routeId: string;
  taskId: string;
  direction: IntercomTransferDirection;
  status: IntercomTransferStatus;
  fileName: string;
  localPath?: string;
  remotePath: string;
  mimeType?: string;
  size?: number;
  durationMs: number;
  error: string | null;
}

interface StoredIntercomConfig extends Record<string, unknown> {
  localHost?: string;
  defaultSessionId?: string;
  agents?: Record<string, Partial<IntercomRouteInput>>;
}

interface LegacyIntercomConfigDocument extends OpenClawConfig {
  intercom?: StoredIntercomConfig;
}

const DEFAULT_SESSION_ID = 'intercom';
const ROUTE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const INTERCOM_PROTOCOL_MARKER = 'KTClaw Intercom Protocol';
const SSH_CONNECT_TIMEOUT_SECONDS = 10;
const INTERCOM_COMMAND_TIMEOUT_MS = 300_000;
const INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS = 120_000;
const INTERCOM_DIRECT_FILE_INSPECT_TIMEOUT_MS = 45_000;
const INTERCOM_DIRECT_FILE_PREVIEW_CHARS = 24_000;
const INTERCOM_DESKTOP_CAMERA_ACCEPT_WAIT_SECONDS = 3;
const INTERCOM_DESKTOP_CAMERA_WAIT_SECONDS = 30;
const INTERCOM_DESKTOP_SCREENSHOT_ACCEPT_WAIT_SECONDS = 3;
const INTERCOM_DESKTOP_SCREENSHOT_WAIT_SECONDS = 15;
const INTERCOM_REMOTE_GATEWAY_ACK_WAIT_SECONDS = 30;
const INTERCOM_REMOTE_GATEWAY_HTTP_TIMEOUT_SECONDS = 5;
const INTERCOM_REMOTE_GATEWAY_HISTORY_TIMEOUT_SECONDS = 20;
const INTERCOM_REMOTE_GATEWAY_SEND_TIMEOUT_SECONDS = 180;
const INTERCOM_REMOTE_GATEWAY_FALLBACK_EXIT_CODE = 87;
const DEFAULT_REMOTE_GATEWAY_PORT = 18789;
const GATEWAY_WEBCHAT_CLIENT_ID = 'webchat-ui';
const GATEWAY_WEBCHAT_CLIENT_DISPLAY_NAME = 'KTClaw WebChat';
const GATEWAY_WEBCHAT_CLIENT_VERSION = '1.0.0';
const GATEWAY_WEBCHAT_CLIENT_MODE = 'webchat';
const GATEWAY_WEBCHAT_TOOL_EVENTS_CAP = 'tool-events';
const INTERCOM_SSH_SECRET_PREFIX = 'intercom:ssh:';
const INTERCOM_CONFIG_FILE = join(getKTClawConfigDir(), 'intercom.json');
const DEFAULT_REMOTE_OPENCLAW_COMMAND = 'openclaw';
const KTCLAW_LINUX_REMOTE_OPENCLAW_COMMAND = 'ELECTRON_RUN_AS_NODE=1 /opt/KTClaw/ktclaw /opt/KTClaw/resources/openclaw/openclaw.mjs';
const KTCLAW_AUTO_REMOTE_LABEL = 'ktclaw-intercom';
const DEFAULT_SSH_PORT = 22;
const DEFAULT_REMOTE_TASK_RETURN: IntercomRemoteTaskReturnChannel[] = ['summary', 'artifacts', 'logs'];
const REMOTE_TASK_RESULT_KEYS = new Set(['success', 'summary', 'artifacts', 'logs', 'error']);
const INTERCOM_REMOTE_BASE_DIR = '~/.ktclaw/intercom';
const INTERCOM_ARTIFACT_CACHE_DIR = join(getKTClawConfigDir(), 'intercom', 'artifacts');
const EXT_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
};
const DIRECT_FILE_INSPECT_EXTENSIONS = new Set([
  '.bash',
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.php',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function normalizeTaskId(value: unknown): string {
  const provided = normalizeString(value);
  const id = provided || randomUUID();
  return id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || randomUUID();
}

function normalizeTaskReturnChannels(value: unknown): IntercomRemoteTaskReturnChannel[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_REMOTE_TASK_RETURN];
  }
  const channels = value.filter((entry): entry is IntercomRemoteTaskReturnChannel => (
    entry === 'summary' || entry === 'artifacts' || entry === 'logs'
  ));
  return channels.length > 0 ? [...new Set(channels)] : [...DEFAULT_REMOTE_TASK_RETURN];
}

function getMimeType(filePath: string): string {
  return EXT_MIME_MAP[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function inferArtifactType(pathOrName: string, mimeType?: string): IntercomRemoteTaskArtifact['type'] {
  const mime = normalizeString(mimeType);
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('archive') || mime.includes('tar')) {
    return 'archive';
  }
  const ext = extname(pathOrName).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
    return 'image';
  }
  if (['.zip', '.gz', '.tar', '.7z', '.rar'].includes(ext)) {
    return 'archive';
  }
  if (['.txt', '.md', '.json', '.csv', '.log'].includes(ext)) {
    return 'text';
  }
  return 'file';
}

function safeRemotePathPart(value: string, fallback = 'file'): string {
  return (value || fallback)
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim() || fallback;
}

function remoteInboxDir(sender: string, taskId: string): string {
  return `${INTERCOM_REMOTE_BASE_DIR}/inbox/${safeRemotePathPart(sender, 'sender')}/${safeRemotePathPart(taskId, 'task')}`;
}

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function toSftpPath(remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  return normalized.startsWith('~/') ? normalized.slice(2) : normalized;
}

function parentRemoteDir(remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '.';
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

function isStoredIntercomConfig(value: unknown): value is StoredIntercomConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStoredIntercomConfig(config: StoredIntercomConfig): StoredIntercomConfig {
  return isStoredIntercomConfig(config) ? config : {};
}

function getLegacyStoredIntercomConfig(config: LegacyIntercomConfigDocument): StoredIntercomConfig {
  return isStoredIntercomConfig(config.intercom)
    ? config.intercom
    : {};
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function commandExists(command: string): Promise<boolean> {
  const pathEnv = process.env.PATH || '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of pathEnv.split(process.platform === 'win32' ? ';' : ':')) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      try {
        await access(join(directory, `${command}${extension}`));
        return true;
      } catch {
        // continue searching PATH
      }
    }
  }
  return false;
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function readStandaloneIntercomConfig(): Promise<StoredIntercomConfig> {
  const config = await readJsonFile<StoredIntercomConfig>(INTERCOM_CONFIG_FILE);
  return getStoredIntercomConfig(config ?? {});
}

async function writeStandaloneIntercomConfig(config: StoredIntercomConfig): Promise<void> {
  await writeJsonFile(INTERCOM_CONFIG_FILE, config);
}

async function migrateLegacyIntercomConfig(): Promise<StoredIntercomConfig> {
  const standalone = await readStandaloneIntercomConfig();
  const openclawConfig = await readOpenClawConfig() as LegacyIntercomConfigDocument;
  const legacy = getLegacyStoredIntercomConfig(openclawConfig);
  const hasLegacy = Object.keys(legacy).length > 0;

  if (!hasLegacy) {
    return standalone;
  }

  const merged: StoredIntercomConfig = {
    ...legacy,
    ...standalone,
    agents: {
      ...(legacy.agents ?? {}),
      ...(standalone.agents ?? {}),
    },
  };
  await writeStandaloneIntercomConfig(ensureIntercomConfig(merged));
  delete openclawConfig.intercom;
  await writeOpenClawConfig(openclawConfig);
  return merged;
}

function getLocalHost(config: StoredIntercomConfig): string {
  return normalizeString(getStoredIntercomConfig(config).localHost) || hostname() || 'local';
}

function getDefaultSessionId(config: StoredIntercomConfig): string {
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

function isTailscaleIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return false;
  }
  const [first, second] = octets;
  return first === 100 && second >= 64 && second <= 127;
}

function isTailscaleInterfaceName(name: string): boolean {
  return name.toLowerCase().includes('tailscale');
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
  if (isTailscaleIpv4(address)) {
    return isTailscaleInterfaceName(name) ? 90 : Number.NEGATIVE_INFINITY;
  }

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

function getShareHostForSsh(config: StoredIntercomConfig): string {
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
  config: StoredIntercomConfig,
  localAgents: Array<{ id: string; name: string }>,
): IntercomSelfConfig {
  const localHost = getLocalHost(config);
  const shareHost = getShareHostForSsh(config);
  const agent = localAgents[0] ?? { id: 'main', name: 'Main' };
  return {
    host: shareHost,
    sshUser: getLocalSshUser(),
    sshPort: DEFAULT_SSH_PORT,
    agentId: agent.id,
    sessionId: getDefaultSessionId(config),
    remoteCommand: DEFAULT_REMOTE_OPENCLAW_COMMAND,
    remoteGatewayPort: DEFAULT_REMOTE_GATEWAY_PORT,
    routeIdExample: `${shareHost}-${agent.id}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || agent.id,
    displayNameExample: `${hostname() || localHost} / ${agent.name || agent.id}`,
  };
}

function isShareableHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return Boolean(normalized)
    && normalized !== 'local'
    && normalized !== 'localhost'
    && normalized !== '127.0.0.1'
    && normalized !== '::1';
}

function isTcpPortListening(port: number, host = '127.0.0.1', timeoutMs = 650): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function getWindowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64');
}

function buildWindowsPrepareScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'",
    "if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' }",
    "Set-Service -Name 'sshd' -StartupType Automatic",
    "Start-Service -Name 'sshd'",
    "$rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue",
    "if ($rule) { Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' } else { New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 }",
  ].join('; ');
}

function buildWindowsDisableScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$service = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue",
    "if ($service) { Stop-Service -Name 'sshd' -Force -ErrorAction SilentlyContinue; Set-Service -Name 'sshd' -StartupType Manual }",
    "$rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue",
    "if ($rule) { Disable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' }",
  ].join('; ');
}

function buildLinuxPrepareScript(): string {
  return [
    'set -e',
    "if command -v sshd >/dev/null 2>&1 || [ -x /usr/sbin/sshd ]; then :; elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y openssh-server; elif command -v dnf >/dev/null 2>&1; then dnf install -y openssh-server; elif command -v yum >/dev/null 2>&1; then yum install -y openssh-server; elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm openssh; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install openssh; elif command -v apk >/dev/null 2>&1; then apk add openssh; else echo 'No supported package manager found for automatic OpenSSH installation.' >&2; exit 2; fi",
    "if command -v systemctl >/dev/null 2>&1; then systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd; elif command -v service >/dev/null 2>&1; then service ssh start 2>/dev/null || service sshd start; else /usr/sbin/sshd 2>/dev/null || sshd; fi",
    "if command -v ufw >/dev/null 2>&1; then ufw allow 22/tcp || true; fi",
    "if command -v firewall-cmd >/dev/null 2>&1; then firewall-cmd --add-service=ssh --permanent || true; firewall-cmd --reload || true; fi",
  ].join('; ');
}

function buildLinuxDisableScript(): string {
  return [
    'set -e',
    "if command -v systemctl >/dev/null 2>&1; then systemctl disable --now ssh 2>/dev/null || systemctl disable --now sshd 2>/dev/null || true; fi",
    "if command -v service >/dev/null 2>&1; then service ssh stop 2>/dev/null || service sshd stop 2>/dev/null || true; fi",
    "if command -v ufw >/dev/null 2>&1; then ufw --force delete allow 22/tcp 2>/dev/null || ufw --force delete allow ssh 2>/dev/null || true; fi",
    "if command -v firewall-cmd >/dev/null 2>&1; then firewall-cmd --remove-service=ssh --permanent 2>/dev/null || true; firewall-cmd --reload 2>/dev/null || true; fi",
  ].join('; ');
}

function buildMacPrepareScript(): string {
  return 'systemsetup -setremotelogin on';
}

function buildMacDisableScript(): string {
  return 'systemsetup -setremotelogin off';
}

function buildHostAccessScript(platform: NodeJS.Platform, enabled: boolean): string | null {
  if (platform === 'win32') {
    return enabled ? buildWindowsPrepareScript() : buildWindowsDisableScript();
  }
  if (platform === 'linux') {
    return enabled ? buildLinuxPrepareScript() : buildLinuxDisableScript();
  }
  if (platform === 'darwin') {
    return enabled ? buildMacPrepareScript() : buildMacDisableScript();
  }
  return null;
}

function buildPrepareCommandPreview(platform: NodeJS.Platform): string | null {
  return buildHostAccessScript(platform, true);
}

async function buildHostAccessInvocation(
  platform: NodeJS.Platform,
  enabled: boolean,
): Promise<{ command: string; args: string[] } | null> {
  const script = buildHostAccessScript(platform, enabled);
  if (!script) {
    return null;
  }
  if (platform === 'win32') {
    const encoded = encodePowerShellCommand(script);
    const launcher = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}')`;
    return {
      command: getWindowsPowerShellPath(),
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher],
    };
  }
  if (platform === 'linux') {
    if (await commandExists('pkexec')) {
      return {
        command: 'pkexec',
        args: ['sh', '-lc', script],
      };
    }
    return {
      command: 'sudo',
      args: ['-n', 'sh', '-lc', script],
    };
  }
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', `do shell script ${JSON.stringify(script)} with administrator privileges`],
    };
  }
  return null;
}

async function buildPrepareInvocation(platform: NodeJS.Platform): Promise<{ command: string; args: string[] } | null> {
  return buildHostAccessInvocation(platform, true);
}

function createReadinessCheck(
  id: IntercomHostReadinessCheck['id'],
  status: IntercomHostReadinessStatus,
  title: string,
  detail: string,
): IntercomHostReadinessCheck {
  return { id, status, title, detail };
}

async function runPrepareInvocation(invocation: { command: string; args: string[] }): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}> {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      env: process.env,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({
        success: false,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: error.message,
      });
    });
    child.on('close', (code) => {
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: code === 0 ? null : `Prepare command exited with code ${code ?? 'unknown'}`,
      });
    });
  });
}

function normalizeStoredRoute(
  id: string,
  value: Partial<IntercomRouteInput> | undefined,
  config: StoredIntercomConfig,
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
    remoteGatewayPort: normalizePositiveInteger(value.remoteGatewayPort),
    source: 'config',
  };
}

function normalizeRouteForStorage(input: IntercomRouteInput, config: StoredIntercomConfig): IntercomRoute {
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
    remoteGatewayPort: normalizePositiveInteger(input.remoteGatewayPort),
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
    ...(route.remoteGatewayPort ? { remoteGatewayPort: route.remoteGatewayPort } : {}),
  };
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePosixRemotePath(value: string): string {
  const normalized = normalizeRemotePath(value);
  const homePrefix = normalized.startsWith('~/')
    ? normalized.slice(2)
    : normalized.startsWith('$HOME/')
      ? normalized.slice('$HOME/'.length)
      : null;
  if (homePrefix !== null) {
    return `"$HOME/${homePrefix.replace(/(["\\`$])/g, '\\$1')}"`;
  }
  return quotePosix(normalized);
}

function quoteRemoteCommandPart(value: string): string {
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
  if (assignment) {
    return `${assignment[1]}=${quotePosix(assignment[2] ?? '')}`;
  }
  return quotePosix(value);
}

function splitPosixCommand(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    current += '\\';
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function buildCallerMessage(sender: string, message: string): string {
  return `[from agent ${sender}] ${message}`;
}

export function buildIntercomRemoteTaskRequest(input: IntercomRemoteTaskSendInput): IntercomRemoteTaskRequest {
  const action = normalizeString(input.action);
  if (!action) {
    throw new Error('remote task action is required');
  }
  const payload = isRecord(input.payload) ? input.payload : {};
  return {
    type: 'remote_task',
    taskId: normalizeTaskId(input.taskId),
    action,
    payload,
    return: normalizeTaskReturnChannels(input.return),
  };
}

export function buildIntercomRemoteTaskMessage(sender: string, task: IntercomRemoteTaskRequest): string {
  const screenshotReturnHint = task.action === 'screenshot'
    ? [
        '',
        'For screenshot tasks, capture the remote screen, save a PNG file under payload.outbox, and include it in artifacts as:',
        '{"type":"image","path":"<payload.outbox>/screenshot.png","name":"screenshot.png","mimeType":"image/png"}',
      ].join('\n')
    : '';
  return buildCallerMessage(
    normalizeString(sender) || 'ktclaw',
    [
      'remote_task:',
      JSON.stringify(task, null, 2),
      '',
      'Return only one JSON object with success, summary, artifacts, logs, and error. Save any files under the task outbox path when one is provided.',
      screenshotReturnHint,
    ].join('\n'),
  );
}

function normalizeIntercomOutput(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replaceAll(String.fromCharCode(0), '')
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
    .trim();
}

function findJsonCandidate(value: string): string | null {
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== '{' && value[start] !== '[') {
      continue;
    }
    if (value[start] === '[') {
      const next = value.slice(start + 1).trimStart()[0];
      if (next && /[A-Za-z]/.test(next) && !['t', 'f', 'n'].includes(next.toLowerCase())) {
        continue;
      }
    }

    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') {
        stack.push('}');
        continue;
      }
      if (char === '[') {
        stack.push(']');
        continue;
      }
      if (char === '}' || char === ']') {
        const expected = stack.pop();
        if (expected !== char) {
          break;
        }
        if (stack.length === 0) {
          return value.slice(start, index + 1);
        }
      }
    }
  }

  return null;
}

function parseIntercomJson(value: string): unknown | null {
  const trimmed = normalizeIntercomOutput(value);
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const candidate = findJsonCandidate(trimmed);
    if (!candidate) {
      return null;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

function readText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(readText).filter(Boolean).join('\n\n').trim();
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') {
      return value.text.trim();
    }
    return readText(value.content ?? value.message ?? value.result ?? value.data);
  }
  return '';
}

function collectAssistantTexts(value: unknown, texts: string[], seen = new Set<unknown>(), depth = 0): void {
  if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAssistantTexts(entry, texts, seen, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (typeof value.role === 'string' && value.role.toLowerCase() === 'assistant') {
    const text = readText(value.content ?? value.message ?? value.text);
    if (text) {
      texts.push(text);
    }
  }

  for (const entry of Object.values(value)) {
    collectAssistantTexts(entry, texts, seen, depth + 1);
  }
}

function isGenericRemoteTaskSummary(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'completed'
    || normalized === 'complete'
    || normalized === 'done'
    || normalized === 'ok'
    || normalized === 'success'
    || normalized === 'task completed'
    || normalized === 'remote task completed';
}

function pushRemoteTaskText(texts: string[], value: string): void {
  const text = value.trim();
  if (!text || texts.at(-1) === text) {
    return;
  }
  texts.push(text);
}

function collectRemoteTaskTexts(value: unknown, texts: string[], seen = new Set<unknown>(), depth = 0): void {
  if (depth > 10 || value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    const parsed = parseIntercomJson(value);
    if (parsed !== null) {
      collectRemoteTaskTexts(parsed, texts, seen, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRemoteTaskTexts(entry, texts, seen, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (text) {
    const parsedText = parseIntercomJson(text);
    if (parsedText !== null) {
      collectRemoteTaskTexts(parsedText, texts, seen, depth + 1);
    } else {
      pushRemoteTaskText(texts, text);
    }
  }

  const summary = readText(value.summary);
  if (summary && !isGenericRemoteTaskSummary(summary)) {
    pushRemoteTaskText(texts, summary);
  }

  for (const key of ['result', 'data', 'message', 'output', 'response', 'content', 'payload', 'payloads', 'messages']) {
    collectRemoteTaskTexts(value[key], texts, seen, depth + 1);
  }
}

function selectRemoteTaskSummary(value: Record<string, unknown>): string {
  const directSummary = readText(value.summary ?? value.message ?? value.output ?? value.response);
  const assistantTexts: string[] = [];
  collectAssistantTexts(value, assistantTexts);
  const payloadTexts: string[] = [];
  collectRemoteTaskTexts(value, payloadTexts);
  const meaningfulPayloadText = [...payloadTexts].reverse().find((text) => !isGenericRemoteTaskSummary(text))
    || [...assistantTexts].reverse().find((text) => !isGenericRemoteTaskSummary(text));

  if (!directSummary || isGenericRemoteTaskSummary(directSummary)) {
    return meaningfulPayloadText || directSummary || '';
  }
  return directSummary;
}

function findTaskResultCandidate(value: unknown, seen = new Set<unknown>(), depth = 0): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const parsed = parseIntercomJson(value);
    return parsed === null ? null : findTaskResultCandidate(parsed, seen, depth + 1);
  }
  if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) {
    return null;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findTaskResultCandidate(entry, seen, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if ([...REMOTE_TASK_RESULT_KEYS].some((key) => key in value)) {
    return value;
  }
  for (const key of ['result', 'data', 'message', 'output', 'response', 'content', 'payload', 'payloads', 'messages']) {
    const found = findTaskResultCandidate(value[key], seen, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

function isOutboxArtifactPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').toLowerCase();
  return normalized.includes('/.ktclaw/intercom/outbox/')
    || normalized.includes('/intercom/outbox/');
}

function hasArtifactMetadata(value: Record<string, unknown>): boolean {
  return typeof value.name === 'string'
    || typeof value.fileName === 'string'
    || typeof value.mimeType === 'string'
    || typeof value.mime === 'string'
    || typeof value.size === 'number'
    || value.type === 'image'
    || value.type === 'directory'
    || value.type === 'archive'
    || value.type === 'text'
    || value.type === 'file';
}

function pushArtifact(artifacts: IntercomRemoteTaskArtifact[], value: unknown): void {
  const artifact = normalizeArtifact(value);
  if (!artifact) {
    return;
  }
  if (artifacts.some((entry) => entry.path === artifact.path)) {
    return;
  }
  artifacts.push(artifact);
}

function collectArtifactPathsFromText(value: string, artifacts: IntercomRemoteTaskArtifact[]): void {
  const pattern = /(?:~|\/|[A-Za-z]:[\\/])(?:[^\s"'`{}[\],]+[\\/])+[^\s"'`{}[\],]+\.(?:png|jpe?g|webp|gif|bmp|svg|pdf|zip|tar|gz|tgz|txt|md|json|csv|html)/gi;
  for (const match of value.matchAll(pattern)) {
    const path = match[0];
    if (isOutboxArtifactPath(path)) {
      pushArtifact(artifacts, path);
    }
  }
}

function collectArtifactCandidates(
  value: unknown,
  artifacts: IntercomRemoteTaskArtifact[] = [],
  seen = new Set<unknown>(),
  depth = 0,
  artifactContext = false,
): IntercomRemoteTaskArtifact[] {
  if (depth > 10 || value === null || value === undefined) {
    return artifacts;
  }

  if (typeof value === 'string') {
    if (artifactContext) {
      pushArtifact(artifacts, value);
    }
    collectArtifactPathsFromText(value, artifacts);
    const parsed = parseIntercomJson(value);
    if (parsed !== null) {
      collectArtifactCandidates(parsed, artifacts, seen, depth + 1, artifactContext);
    }
    return artifacts;
  }

  if (typeof value !== 'object' || seen.has(value)) {
    return artifacts;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectArtifactCandidates(entry, artifacts, seen, depth + 1, artifactContext);
    }
    return artifacts;
  }

  if (!isRecord(value)) {
    return artifacts;
  }

  if (Array.isArray(value.artifacts)) {
    for (const entry of value.artifacts) {
      collectArtifactCandidates(entry, artifacts, seen, depth + 1, true);
    }
  }

  const path = normalizeString(value.path ?? value.remotePath ?? value.filePath);
  if (path && (artifactContext || isOutboxArtifactPath(path) || hasArtifactMetadata(value))) {
    pushArtifact(artifacts, value);
  }

  for (const entry of Object.values(value)) {
    collectArtifactCandidates(entry, artifacts, seen, depth + 1, false);
  }

  return artifacts;
}

function normalizeArtifact(value: unknown): IntercomRemoteTaskArtifact | null {
  if (typeof value === 'string') {
    const path = normalizeString(value);
    return path ? {
      type: inferArtifactType(path),
      path,
      name: basename(path),
      mimeType: getMimeType(path),
    } : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const path = normalizeString(value.path ?? value.remotePath ?? value.filePath);
  if (!path) {
    return null;
  }
  const mimeType = normalizeString(value.mimeType ?? value.mime) || getMimeType(path);
  const declaredType = value.type === 'image'
    || value.type === 'directory'
    || value.type === 'archive'
    || value.type === 'text'
    || value.type === 'file'
    ? value.type
    : inferArtifactType(path, mimeType);
  return {
    type: declaredType,
    path,
    name: normalizeString(value.name ?? value.fileName) || basename(path),
    mimeType,
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : undefined,
  };
}

function normalizeTaskResultFromObject(value: Record<string, unknown>, stdout: string): IntercomRemoteTaskResult {
  const summary = selectRemoteTaskSummary(value);
  const logs = readText(value.logs ?? value.log ?? value.stderr ?? value.stdout) || stdout;
  const artifacts = collectArtifactCandidates(value);
  const rawError = value.error ?? value.message;
  const error = value.success === false ? (readText(rawError) || 'Remote task failed') : (readText(value.error) || null);
  return {
    success: value.success === false ? false : !error,
    summary,
    artifacts,
    logs,
    error,
  };
}

export function normalizeIntercomRemoteTaskResult(stdout: string): IntercomRemoteTaskResult {
  const normalized = normalizeIntercomOutput(stdout);
  if (!normalized) {
    return {
      success: true,
      summary: '',
      artifacts: [],
      logs: '',
      error: null,
    };
  }

  const parsed = parseIntercomJson(normalized);
  if (parsed !== null) {
    const candidate = findTaskResultCandidate(parsed);
    if (candidate) {
      return normalizeTaskResultFromObject(candidate, normalized);
    }
    const assistantTexts: string[] = [];
    collectAssistantTexts(parsed, assistantTexts);
    const payloadTexts: string[] = [];
    collectRemoteTaskTexts(parsed, payloadTexts);
    const text = payloadTexts.at(-1) || assistantTexts.at(-1) || readText(parsed);
    return {
      success: true,
      summary: text,
      artifacts: collectArtifactCandidates(parsed),
      logs: normalized,
      error: null,
    };
  }

  return {
    success: true,
    summary: normalized.length <= 4000 ? normalized : `${normalized.slice(0, 4000).trim()}\n...`,
    artifacts: [],
    logs: normalized,
    error: null,
  };
}

function hasMeaningfulRemoteTaskResult(result: IntercomRemoteTaskResult): boolean {
  return Boolean(
    result.summary.trim()
    || result.error
    || result.artifacts.length > 0
    || normalizeIntercomOutput(result.logs).includes('"payloads"')
    || normalizeIntercomOutput(result.logs).includes('"messages"'),
  );
}

export function normalizeIntercomRemoteTaskCommandResult(output: { stdout: string; stderr: string }): IntercomRemoteTaskResult {
  const stdoutResult = normalizeIntercomRemoteTaskResult(output.stdout);
  if (hasMeaningfulRemoteTaskResult(stdoutResult)) {
    return stdoutResult;
  }
  const stderr = normalizeIntercomOutput(output.stderr);
  if (!stderr || !/^[{[]|"(?:success|summary|artifacts|payloads|messages|text)"\s*:/.test(stderr)) {
    return stdoutResult;
  }
  const stderrResult = normalizeIntercomRemoteTaskResult(stderr);
  return hasMeaningfulRemoteTaskResult(stderrResult) ? stderrResult : stdoutResult;
}

function buildLocalCommand(route: IntercomRoute, message: string, sessionId: string) {
  return {
    command: process.execPath,
    args: [
      getOpenClawEntryPath(),
      'agent',
      '--to',
      buildIntercomSessionKey(route, sessionId),
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

function resolveRemoteGatewayPort(route: IntercomRoute): number {
  return normalizePositiveInteger(route.remoteGatewayPort) || DEFAULT_REMOTE_GATEWAY_PORT;
}

function buildRemoteOpenClawCommand(route: IntercomRoute, message: string, sessionId: string): string {
  const remoteArgs = [
    'agent',
    '--local',
    '--to',
    buildIntercomSessionKey(route, sessionId),
    '--agent',
    route.agent,
    '--session-id',
    sessionId,
    '--message',
    message,
    '--json',
  ];
  const commandParts = splitPosixCommand(resolveRemoteCommandPrefix(route));
  const remoteCommandPrefix = commandParts.length > 0
    ? commandParts.map(quoteRemoteCommandPart).join(' ')
    : quotePosix(DEFAULT_REMOTE_OPENCLAW_COMMAND);
  return `${remoteCommandPrefix} ${remoteArgs.map(quotePosix).join(' ')}`;
}

function resolveRemoteCommandArgs(route: IntercomRoute): string[] {
  const commandParts = splitPosixCommand(resolveRemoteCommandPrefix(route));
  return commandParts.length > 0 ? commandParts : [DEFAULT_REMOTE_OPENCLAW_COMMAND];
}

function buildRemoteGatewayPayload(route: IntercomRoute, message: string, sessionId: string): string {
  return Buffer.from(JSON.stringify({
    sessionKey: buildIntercomSessionKey(route, sessionId),
    message,
    idempotencyKey: `intercom-${randomUUID()}`,
    timeoutSeconds: INTERCOM_REMOTE_GATEWAY_ACK_WAIT_SECONDS,
    httpTimeoutSeconds: INTERCOM_REMOTE_GATEWAY_HTTP_TIMEOUT_SECONDS,
    historyTimeoutSeconds: INTERCOM_REMOTE_GATEWAY_HISTORY_TIMEOUT_SECONDS,
    sendHttpTimeoutSeconds: INTERCOM_REMOTE_GATEWAY_SEND_TIMEOUT_SECONDS,
    gatewayPort: resolveRemoteGatewayPort(route),
    remoteCommand: resolveRemoteCommandPrefix(route),
    remoteCommandArgs: resolveRemoteCommandArgs(route),
    preferGatewayCli: true,
  }), 'utf8').toString('base64');
}

function buildPythonGatewayRpcHelper(): string {
  return `
import hashlib
import json
import os
import socket
import struct
import subprocess
import time
import urllib.error
import urllib.request

_gateway_ws_client = None

def _read_gateway_token():
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN") or os.environ.get("KTCLAW_GATEWAY_TOKEN")
    if token:
        return token
    candidates = [
        os.path.expanduser("~/.openclaw/openclaw.json"),
        os.path.expanduser("~/.config/openclaw/openclaw.json"),
    ]
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                config = json.load(handle)
            gateway = config.get("gateway") if isinstance(config, dict) else {}
            auth = gateway.get("auth") if isinstance(gateway, dict) else {}
            remote = gateway.get("remote") if isinstance(gateway, dict) else {}
            for value in (
                auth.get("token") if isinstance(auth, dict) else None,
                remote.get("token") if isinstance(remote, dict) else None,
            ):
                if isinstance(value, str) and value.strip():
                    return value.strip()
        except Exception:
            pass
    return ""

def _recv_exact(sock, size):
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            raise RuntimeError("WebSocket connection closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

def _mask_payload(payload, mask):
    return bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

class _GatewayWsClient:
    def __init__(self, host, port, token, timeout):
        self.host = host
        self.port = port
        self.token = token or ""
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            "GET /ws HTTP/1.1\\r\\n"
            "Host: %s:%d\\r\\n"
            "Origin: http://127.0.0.1:%d\\r\\n"
            "Upgrade: websocket\\r\\n"
            "Connection: Upgrade\\r\\n"
            "Sec-WebSocket-Key: %s\\r\\n"
            "Sec-WebSocket-Version: 13\\r\\n"
            "\\r\\n"
        ) % (host, port, port, key)
        self.sock.sendall(request.encode("ascii"))
        response = b""
        while b"\\r\\n\\r\\n" not in response:
            response += _recv_exact(self.sock, 1)
            if len(response) > 8192:
                raise RuntimeError("WebSocket handshake response too large")
        status_line = response.split(b"\\r\\n", 1)[0].decode("latin1", errors="replace")
        if " 101 " not in status_line:
            raise RuntimeError("WebSocket handshake failed: %s" % status_line)
        challenge = self.recv_json(timeout)
        if not (isinstance(challenge, dict) and challenge.get("type") == "event" and challenge.get("event") == "connect.challenge"):
            raise RuntimeError("WebSocket did not send connect.challenge")
        challenge_payload = challenge.get("payload") if isinstance(challenge.get("payload"), dict) else {}
        nonce = challenge_payload.get("nonce")
        if not isinstance(nonce, str) or not nonce:
            raise RuntimeError("WebSocket connect.challenge missing nonce")
        connect_id = "connect-%d" % time.time_ns()
        self.send_json({
            "type": "req",
            "id": connect_id,
            "method": "connect",
            "params": {
                "minProtocol": 3,
                "maxProtocol": 3,
                "client": {
                    "id": "${GATEWAY_WEBCHAT_CLIENT_ID}",
                    "displayName": "${GATEWAY_WEBCHAT_CLIENT_DISPLAY_NAME}",
                    "version": "${GATEWAY_WEBCHAT_CLIENT_VERSION}",
                    "platform": sys.platform,
                    "mode": "${GATEWAY_WEBCHAT_CLIENT_MODE}",
                },
                "auth": {"token": self.token},
                "caps": ["${GATEWAY_WEBCHAT_TOOL_EVENTS_CAP}"],
                "role": "operator",
                "scopes": ["operator.read", "operator.write", "operator.admin"],
            },
        })
        self._wait_response(connect_id, timeout)

    def close(self):
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass

    def send_frame(self, payload, opcode=1):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        length = len(payload)
        header = bytearray([0x80 | opcode])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        mask = os.urandom(4)
        header.extend(mask)
        self.sock.sendall(bytes(header) + _mask_payload(payload, mask))

    def send_json(self, value):
        self.send_frame(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

    def recv_text(self, timeout):
        self.sock.settimeout(timeout)
        fragments = []
        while True:
            header = _recv_exact(self.sock, 2)
            first = header[0]
            second = header[1]
            fin = (first & 0x80) != 0
            opcode = first & 0x0F
            masked = (second & 0x80) != 0
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", _recv_exact(self.sock, 2))[0]
            elif length == 127:
                length = struct.unpack("!Q", _recv_exact(self.sock, 8))[0]
            mask = _recv_exact(self.sock, 4) if masked else None
            payload = _recv_exact(self.sock, length) if length else b""
            if mask:
                payload = _mask_payload(payload, mask)
            if opcode == 8:
                raise RuntimeError("WebSocket closed by Gateway")
            if opcode == 9:
                self.send_frame(payload, opcode=10)
                continue
            if opcode in (1, 0):
                fragments.append(payload)
                if fin:
                    return b"".join(fragments).decode("utf-8")
            elif opcode == 10:
                continue

    def recv_json(self, timeout):
        return json.loads(self.recv_text(timeout))

    def _wait_response(self, request_id, timeout):
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise RuntimeError("WebSocket RPC timeout: %s" % request_id)
            message = self.recv_json(max(0.1, remaining))
            if not isinstance(message, dict) or message.get("id") != request_id:
                continue
            if message.get("type") == "res":
                if message.get("ok") is False or message.get("error"):
                    raise RuntimeError(str(message.get("error") or "Gateway WebSocket RPC failed"))
                return message.get("payload")
            if "ok" in message:
                if not message.get("ok"):
                    raise RuntimeError(str(message.get("error") or "Gateway WebSocket RPC failed"))
                return message.get("data", message)
            return message

    def rpc(self, method, params, timeout):
        request_id = "intercom-ws-%d" % time.time_ns()
        self.send_json({
            "type": "req",
            "id": request_id,
            "method": method,
            "params": params,
        })
        return self._wait_response(request_id, timeout)

def _rpc_http(gateway_url, method, params, timeout):
    body = json.dumps({
        "type": "req",
        "id": "intercom-http-%d" % time.time_ns(),
        "method": method,
        "params": params,
    }).encode("utf-8")
    request = urllib.request.Request(
        gateway_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace").strip()
        except Exception:
            pass
        if detail:
            raise RuntimeError("HTTP %s: %s" % (exc.code, detail[:300]))
        raise RuntimeError("HTTP %s: %s" % (exc.code, exc.reason))
    if isinstance(data, dict) and data.get("type") == "res":
        if data.get("ok") is False or data.get("error"):
            raise RuntimeError(str(data.get("error") or "Gateway RPC failed"))
        return data.get("payload")
    if isinstance(data, dict) and "ok" in data:
        if not data.get("ok"):
            raise RuntimeError(str(data.get("error") or "Gateway RPC failed"))
        return data.get("data", data)
    return data

def _parse_cli_json(stdout):
    text = (stdout or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return json.loads(text[start:end + 1])
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        return json.loads(text[start:end + 1])
    raise RuntimeError("Gateway CLI returned non-JSON output: %s" % text[:300])

def _is_env_assignment(value):
    if not isinstance(value, str) or "=" not in value:
        return False
    name = value.split("=", 1)[0]
    if not name or not (name[0].isalpha() or name[0] == "_"):
        return False
    return all(ch.isalnum() or ch == "_" for ch in name)

def _command_env_and_args(command_args):
    env = os.environ.copy()
    resolved = []
    for value in command_args:
        text = str(value)
        if not resolved and _is_env_assignment(text):
            key, env_value = text.split("=", 1)
            env[key] = env_value
            continue
        if text:
            resolved.append(text)
    return env, (resolved or ["openclaw"])

def _rpc_cli(method, params, timeout):
    command_args = payload.get("remoteCommandArgs")
    if not isinstance(command_args, list) or not command_args:
        command = str(payload.get("remoteCommand") or "openclaw").strip() or "openclaw"
        command_args = [command]
    command_args = [str(arg) for arg in command_args if str(arg)]
    env, command_args = _command_env_and_args(command_args)
    token = _read_gateway_token()
    timeout_ms = str(max(1000, int(float(timeout) * 1000)))
    args = [
        "gateway",
        "call",
        method,
        "--url",
        "ws://127.0.0.1:%d" % gateway_port,
        "--timeout",
        timeout_ms,
        "--json",
        "--params",
        json.dumps(params, ensure_ascii=False, separators=(",", ":")),
    ]
    if token:
        args.extend(["--token", token])
    if token:
        env["OPENCLAW_GATEWAY_TOKEN"] = token
    process_timeout = max(1.0, float(timeout)) + 2.0
    try:
        completed = subprocess.run(
            command_args + args,
            shell=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            timeout=process_timeout,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("Gateway CLI RPC timed out after %.1f seconds" % process_timeout)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "exit code %d" % completed.returncode).strip()
        raise RuntimeError("Gateway CLI RPC failed: %s" % detail[:500])
    return _parse_cli_json(completed.stdout)

def gateway_rpc(method, params, timeout=None):
    global _gateway_ws_client
    effective_timeout = float(timeout or http_timeout)
    errors = []
    if bool(payload.get("preferGatewayCli")):
        try:
            return _rpc_cli(method, params, effective_timeout)
        except Exception as exc:
            errors.append("cli: %s" % exc)
    if _gateway_ws_client is None:
        try:
            _gateway_ws_client = _GatewayWsClient("127.0.0.1", gateway_port, _read_gateway_token(), effective_timeout)
        except Exception as exc:
            errors.append("ws connect: %s" % exc)
            _gateway_ws_client = None
    if _gateway_ws_client is not None:
        try:
            return _gateway_ws_client.rpc(method, params, effective_timeout)
        except Exception as exc:
            errors.append("ws rpc: %s" % exc)
            try:
                _gateway_ws_client.close()
            finally:
                _gateway_ws_client = None
    try:
        return _rpc_http(gateway_url, method, params, effective_timeout)
    except Exception as exc:
        errors.append("http: %s" % exc)
        raise RuntimeError("; ".join(errors))
`.trim();
}

function buildPowerShellGatewayRpcHelper(): string[] {
  return [
    'function Get-KTClawGatewayToken {',
    '$token = $env:OPENCLAW_GATEWAY_TOKEN; if ([string]::IsNullOrWhiteSpace($token)) { $token = $env:KTCLAW_GATEWAY_TOKEN }; if (-not [string]::IsNullOrWhiteSpace($token)) { return [string]$token }',
    "$paths = @((Join-Path $HOME '.openclaw\\openclaw.json'), (Join-Path $HOME '.config\\openclaw\\openclaw.json'))",
    'foreach ($path in $paths) { try { if (-not (Test-Path -LiteralPath $path)) { continue }; $config = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json; if ($config.gateway.auth.token) { return [string]$config.gateway.auth.token }; if ($config.gateway.remote.token) { return [string]$config.gateway.remote.token } } catch {} }',
    'return ""',
    '}',
    'function ConvertFrom-KTClawGatewayCliJson { param([string]$Text) $trimmed = ([string]$Text).Trim(); if ([string]::IsNullOrWhiteSpace($trimmed)) { return $null }; try { return ($trimmed | ConvertFrom-Json) } catch {}; $start = $trimmed.IndexOf("{"); $end = $trimmed.LastIndexOf("}"); if ($start -ge 0 -and $end -gt $start) { return ($trimmed.Substring($start, $end - $start + 1) | ConvertFrom-Json) }; $start = $trimmed.IndexOf("["); $end = $trimmed.LastIndexOf("]"); if ($start -ge 0 -and $end -gt $start) { return ($trimmed.Substring($start, $end - $start + 1) | ConvertFrom-Json) }; throw ("Gateway CLI returned non-JSON output: " + $trimmed.Substring(0, [Math]::Min(300, $trimmed.Length))) }',
    'function Invoke-KTClawOpenClawCommand { param([object[]]$Arguments) $candidates = @(); $lastError = $null; $cmd = Get-Command openclaw -ErrorAction SilentlyContinue; if ($cmd) { $candidates += @{ File = [string]$cmd.Source; Prefix = @() } }; $candidatePaths = @((Join-Path (Get-Location) "node_modules\\.bin\\openclaw.cmd"), (Join-Path (Get-Location) "resources\\cli\\win32\\openclaw.cmd"), "$env:USERPROFILE\\Desktop\\claw\\KTClaw\\node_modules\\.bin\\openclaw.cmd", "$env:USERPROFILE\\Desktop\\KTClaw\\node_modules\\.bin\\openclaw.cmd", "$env:USERPROFILE\\Desktop\\ClawX-main\\node_modules\\.bin\\openclaw.cmd", "$env:LOCALAPPDATA\\Programs\\KTClaw\\resources\\cli\\win32\\openclaw.cmd", "$env:ProgramFiles\\KTClaw\\resources\\cli\\win32\\openclaw.cmd"); foreach ($path in $candidatePaths) { if ($path -and (Test-Path -LiteralPath $path)) { $candidates += @{ File = [string]$path; Prefix = @() } } }; $electronEntries = @(@{ Exe = "$env:LOCALAPPDATA\\Programs\\KTClaw\\KTClaw.exe"; Mjs = "$env:LOCALAPPDATA\\Programs\\KTClaw\\resources\\openclaw\\openclaw.mjs" }, @{ Exe = "$env:ProgramFiles\\KTClaw\\KTClaw.exe"; Mjs = "$env:ProgramFiles\\KTClaw\\resources\\openclaw\\openclaw.mjs" }); foreach ($entry in $electronEntries) { if ((Test-Path -LiteralPath $entry.Exe) -and (Test-Path -LiteralPath $entry.Mjs)) { $candidates += @{ File = [string]$entry.Exe; Prefix = @([string]$entry.Mjs); Electron = $true } } }; foreach ($candidate in $candidates) { $oldElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE; try { if ($candidate.Electron) { $env:ELECTRON_RUN_AS_NODE = "1" }; $allArgs = @($candidate.Prefix) + @($Arguments); $output = & $candidate.File @allArgs 2>&1; $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }; $text = ($output | Out-String); if ($exitCode -eq 0) { return $text }; $lastError = "exit code " + $exitCode + ": " + $text.Trim() } catch { $lastError = $_.Exception.Message } finally { $env:ELECTRON_RUN_AS_NODE = $oldElectronRunAsNode } }; if (-not [string]::IsNullOrWhiteSpace($lastError)) { throw $lastError }; throw "KTClaw/OpenClaw command not found. Install openclaw globally or set Remote OpenClaw command to the KTClaw/OpenClaw executable path." }',
    'function Invoke-KTClawGatewayCliRpc { param([string]$Method, $Params, [int]$TimeoutSec) $timeoutMs = [string]([Math]::Max(1000, [int]($TimeoutSec * 1000))); $paramsJson = $Params | ConvertTo-Json -Depth 60 -Compress; $arguments = @("gateway", "call", $Method, "--url", "ws://127.0.0.1:$gatewayPort", "--timeout", $timeoutMs, "--json", "--params", $paramsJson); $token = Get-KTClawGatewayToken; $oldToken = $env:OPENCLAW_GATEWAY_TOKEN; try { if (-not [string]::IsNullOrWhiteSpace($token)) { $env:OPENCLAW_GATEWAY_TOKEN = $token; $arguments += @("--token", $token) }; return (ConvertFrom-KTClawGatewayCliJson (Invoke-KTClawOpenClawCommand $arguments)) } finally { $env:OPENCLAW_GATEWAY_TOKEN = $oldToken } }',
    '$script:KTClawGatewayWs = $null',
    'function New-KTClawTimeoutToken { param([int]$TimeoutSec) return [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds([Math]::Max(1, $TimeoutSec))).Token }',
    'function Send-KTClawGatewayWsJson { param([System.Net.WebSockets.ClientWebSocket]$Socket, $Value, [int]$TimeoutSec) $json = $Value | ConvertTo-Json -Depth 60 -Compress; $bytes = [Text.Encoding]::UTF8.GetBytes($json); $segment = [ArraySegment[byte]]::new($bytes); $Socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, (New-KTClawTimeoutToken $TimeoutSec)).GetAwaiter().GetResult() }',
    'function Receive-KTClawGatewayWsJson { param([System.Net.WebSockets.ClientWebSocket]$Socket, [int]$TimeoutSec) $buffer = New-Object byte[] 65536; $stream = New-Object System.IO.MemoryStream; do { $segment = [ArraySegment[byte]]::new($buffer); $result = $Socket.ReceiveAsync($segment, (New-KTClawTimeoutToken $TimeoutSec)).GetAwaiter().GetResult(); if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { throw "WebSocket closed by Gateway" }; if ($result.Count -gt 0) { $stream.Write($buffer, 0, $result.Count) } } while (-not $result.EndOfMessage); $text = [Text.Encoding]::UTF8.GetString($stream.ToArray()); return ($text | ConvertFrom-Json) }',
    'function Wait-KTClawGatewayWsResponse { param([System.Net.WebSockets.ClientWebSocket]$Socket, [string]$RequestId, [int]$TimeoutSec) $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSec)); while ([DateTime]::UtcNow -lt $deadline) { $remaining = [Math]::Max(1, [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)); $message = Receive-KTClawGatewayWsJson $Socket $remaining; if (-not ($message.PSObject.Properties.Name -contains "id") -or [string]$message.id -ne $RequestId) { continue }; if ($message.type -eq "res") { if (($message.PSObject.Properties.Name -contains "ok" -and $message.ok -eq $false) -or $message.error) { throw ($message.error | ConvertTo-Json -Depth 10 -Compress) }; return $message.payload }; if ($message.PSObject.Properties.Name -contains "ok") { if (-not $message.ok) { throw [string]$message.error }; return $message.data }; return $message }; throw "WebSocket RPC timeout: $RequestId" }',
    `function Connect-KTClawGatewayWs { param([int]$TimeoutSec) $socket = [System.Net.WebSockets.ClientWebSocket]::new(); $socket.Options.SetRequestHeader("Origin", "http://127.0.0.1:$gatewayPort"); $socket.ConnectAsync([Uri]("ws://127.0.0.1:$gatewayPort/ws"), (New-KTClawTimeoutToken $TimeoutSec)).GetAwaiter().GetResult(); $challenge = Receive-KTClawGatewayWsJson $socket $TimeoutSec; if ($challenge.type -ne "event" -or $challenge.event -ne "connect.challenge") { throw "WebSocket did not send connect.challenge" }; $connectId = "connect-" + [guid]::NewGuid().ToString(); Send-KTClawGatewayWsJson $socket @{ type = "req"; id = $connectId; method = "connect"; params = @{ minProtocol = 3; maxProtocol = 3; client = @{ id = "${GATEWAY_WEBCHAT_CLIENT_ID}"; displayName = "${GATEWAY_WEBCHAT_CLIENT_DISPLAY_NAME}"; version = "${GATEWAY_WEBCHAT_CLIENT_VERSION}"; platform = "win32"; mode = "${GATEWAY_WEBCHAT_CLIENT_MODE}" }; auth = @{ token = (Get-KTClawGatewayToken) }; caps = @("${GATEWAY_WEBCHAT_TOOL_EVENTS_CAP}"); role = "operator"; scopes = @("operator.read", "operator.write", "operator.admin") } } $TimeoutSec; [void](Wait-KTClawGatewayWsResponse $socket $connectId $TimeoutSec); return $socket }`,
    'function Invoke-KTClawGatewayHttpRpc { param([string]$Method, $Params, [int]$TimeoutSec) $body = @{ type = "req"; id = ("intercom-http-" + [guid]::NewGuid().ToString()); method = $Method; params = $Params } | ConvertTo-Json -Depth 60 -Compress; $response = Invoke-RestMethod -Uri $gatewayUrl -Method Post -ContentType "application/json" -Body $body -TimeoutSec $TimeoutSec; if ($response.type -eq "res") { if (($response.PSObject.Properties.Name -contains "ok" -and $response.ok -eq $false) -or $response.error) { throw ($response.error | ConvertTo-Json -Depth 10 -Compress) }; return $response.payload }; if ($response.PSObject.Properties.Name -contains "ok") { if (-not $response.ok) { throw [string]$response.error }; return $response.data }; return $response }',
    'function Invoke-KTClawGatewayWsRpc { param([string]$Method, $Params, [int]$TimeoutSec) $requestId = "intercom-ws-" + [guid]::NewGuid().ToString(); Send-KTClawGatewayWsJson $script:KTClawGatewayWs @{ type = "req"; id = $requestId; method = $Method; params = $Params } $TimeoutSec; return (Wait-KTClawGatewayWsResponse $script:KTClawGatewayWs $requestId $TimeoutSec) }',
    'function Invoke-KTClawGatewaySmartRpc { param([string]$Method, $Params, [int]$TimeoutSec) $errors = New-Object System.Collections.Generic.List[string]; if (($payload.PSObject.Properties.Name -contains "preferGatewayCli") -and [bool]$payload.preferGatewayCli) { try { return (Invoke-KTClawGatewayCliRpc $Method $Params $TimeoutSec) } catch { [void]$errors.Add("cli: " + $_.Exception.Message) } }; if ($null -eq $script:KTClawGatewayWs -or $script:KTClawGatewayWs.State -ne [System.Net.WebSockets.WebSocketState]::Open) { try { $script:KTClawGatewayWs = Connect-KTClawGatewayWs $TimeoutSec } catch { [void]$errors.Add("ws connect: " + $_.Exception.Message); $script:KTClawGatewayWs = $null } }; if ($null -ne $script:KTClawGatewayWs) { try { return (Invoke-KTClawGatewayWsRpc $Method $Params $TimeoutSec) } catch { [void]$errors.Add("ws rpc: " + $_.Exception.Message); try { $script:KTClawGatewayWs.Dispose() } catch {}; $script:KTClawGatewayWs = $null } }; try { return (Invoke-KTClawGatewayHttpRpc $Method $Params $TimeoutSec) } catch { [void]$errors.Add("http: " + $_.Exception.Message); throw ($errors -join "; ") } }',
  ];
}

function buildPosixRemoteGatewayCommand(
  route: IntercomRoute,
  message: string,
  sessionId: string,
  fallbackCommand: string | null,
): string {
  const payloadBase64 = buildRemoteGatewayPayload(route, message, sessionId);
  const gatewayPort = resolveRemoteGatewayPort(route);
  const pythonScript = `
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

payload = json.loads(base64.b64decode(os.environ["KTCLAW_INTERCOM_GATEWAY_PAYLOAD_B64"]).decode("utf-8"))
http_timeout = float(payload.get("httpTimeoutSeconds") or ${INTERCOM_REMOTE_GATEWAY_HTTP_TIMEOUT_SECONDS})
history_timeout = float(payload.get("historyTimeoutSeconds") or ${INTERCOM_REMOTE_GATEWAY_HISTORY_TIMEOUT_SECONDS})
poll_timeout = float(payload.get("timeoutSeconds") or ${INTERCOM_REMOTE_GATEWAY_ACK_WAIT_SECONDS})
gateway_port = int(payload.get("gatewayPort") or ${DEFAULT_REMOTE_GATEWAY_PORT})
gateway_url = "http://127.0.0.1:%d/rpc" % gateway_port
sent = False

${buildPythonGatewayRpcHelper()}

def rpc(method, params, timeout=None):
    return gateway_rpc(method, params, timeout or http_timeout)

def messages_from(value):
    if isinstance(value, dict):
        items = value.get("messages") or value.get("history")
        return items if isinstance(items, list) else []
    return value if isinstance(value, list) else []

def text_from_content(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                value = item.get("text") or item.get("content")
                if isinstance(value, str):
                    parts.append(value)
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts).strip()
    if isinstance(content, dict):
        value = content.get("text") or content.get("content")
        return value.strip() if isinstance(value, str) else ""
    return ""

try:
    session_key = payload["sessionKey"]
    history_params = {"sessionKey": session_key, "limit": 500}
    history_warning = None
    try:
        before = messages_from(rpc("chat.history", history_params, history_timeout))
    except Exception as exc:
        history_warning = "pre-send history unavailable: %s" % exc
        before = []
    before_count = len(before)
    run_dir = os.path.expanduser("~/.ktclaw/intercom/gateway-runs")
    os.makedirs(run_dir, exist_ok=True)
    run_log = os.path.join(run_dir, "%s.json" % payload["idempotencyKey"].replace("/", "_"))
    child_payload = dict(payload)
    child_payload["runLog"] = run_log
    child_payload_b64 = base64.b64encode(json.dumps(child_payload).encode("utf-8")).decode("ascii")
    child_code = r'''
import base64
import json
import os
import time
import urllib.error
import urllib.request

payload = json.loads(base64.b64decode(os.environ["KTCLAW_INTERCOM_GATEWAY_PAYLOAD_B64"]).decode("utf-8"))
gateway_port = int(payload.get("gatewayPort") or ${DEFAULT_REMOTE_GATEWAY_PORT})
gateway_url = "http://127.0.0.1:%d/rpc" % gateway_port
send_timeout = float(payload.get("sendHttpTimeoutSeconds") or 180)

${buildPythonGatewayRpcHelper()}

def write_log(value):
    try:
        with open(os.path.expanduser(payload["runLog"]), "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
    except Exception:
        pass

def rpc(method, params, timeout=None):
    return gateway_rpc(method, params, timeout or send_timeout)

try:
    result = rpc("chat.send", {
        "sessionKey": payload["sessionKey"],
        "message": payload["message"],
        "deliver": False,
        "idempotencyKey": payload["idempotencyKey"],
    }, send_timeout)
    write_log({"ok": True, "result": result})
except Exception as exc:
    write_log({"ok": False, "error": str(exc)})
'''
    child_env = os.environ.copy()
    child_env["KTCLAW_INTERCOM_GATEWAY_PAYLOAD_B64"] = child_payload_b64
    subprocess.Popen(
        [sys.executable, "-c", child_code],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=child_env,
        start_new_session=True,
    )
    sent = True
    deadline = time.time() + poll_timeout
    latest = before
    while time.time() < deadline:
        time.sleep(1.0)
        try:
            latest = messages_from(rpc("chat.history", history_params, history_timeout))
        except Exception as exc:
            history_warning = "post-send history unavailable: %s" % exc
            break
        new_messages = latest[before_count:] if len(latest) >= before_count else latest
        for message in new_messages:
            if isinstance(message, dict) and message.get("role") == "assistant" and text_from_content(message.get("content")):
                print(json.dumps({
                    "messages": new_messages,
                    "result": {"dispatched": True, "runLog": run_log},
                    "meta": {"via": "remote-gateway", "status": "completed", "beforeCount": before_count, "sessionKey": session_key, "messageCount": len(latest)},
                }, ensure_ascii=False))
                sys.exit(0)
    print(json.dumps({
        "messages": latest[before_count:] if len(latest) >= before_count else latest,
        "result": {"dispatched": True, "runLog": run_log},
        "meta": {"via": "remote-gateway", "status": "running", "beforeCount": before_count, "sessionKey": session_key, "messageCount": len(latest), "warning": history_warning},
    }, ensure_ascii=False))
except Exception as exc:
    if not sent:
        sys.stderr.write("Remote Gateway fast path unavailable: %s\\n" % exc)
        sys.exit(${INTERCOM_REMOTE_GATEWAY_FALLBACK_EXIT_CODE})
    print(json.dumps({
        "messages": [{"role": "assistant", "content": "Remote Gateway run failed: %s" % exc}],
        "meta": {"via": "remote-gateway", "error": str(exc)},
    }, ensure_ascii=False))
`;
  const script = [
    `if command -v python3 >/dev/null 2>&1; then KTCLAW_INTERCOM_GATEWAY_PAYLOAD_B64=${quotePosix(payloadBase64)} python3 - <<'PY'`,
    pythonScript.trim(),
    'PY',
    'status=$?',
    'if [ "$status" -eq 0 ]; then exit 0; fi',
    `if [ "$status" -ne ${INTERCOM_REMOTE_GATEWAY_FALLBACK_EXIT_CODE} ]; then exit "$status"; fi`,
    'fi',
    fallbackCommand
      ?? [
        `echo "Remote Gateway is unavailable on 127.0.0.1:${gatewayPort}. Open KTClaw on the remote machine, confirm its Gateway port matches this route, and keep Gateway running; normal Intercom messages no longer cold-start openclaw agent automatically." >&2`,
        `exit ${INTERCOM_REMOTE_GATEWAY_FALLBACK_EXIT_CODE}`,
      ].join('\n'),
  ].join('\n');
  return `sh -lc ${quotePosix(script)}`;
}

function buildRemoteCommand(
  route: IntercomRoute,
  message: string,
  sessionId: string,
  options: { allowCliFallback?: boolean } = {},
): string {
  const fallbackCommand = buildRemoteOpenClawCommand(route, message, sessionId);
  return buildPosixRemoteGatewayCommand(
    route,
    message,
    sessionId,
    options.allowCliFallback === false ? null : fallbackCommand,
  );
}

function buildRemoteGatewayHistoryPayload(route: IntercomRoute, sessionId: string, beforeCount: number): string {
  return Buffer.from(JSON.stringify({
    sessionKey: buildIntercomSessionKey(route, sessionId),
    beforeCount: Math.max(0, Math.floor(beforeCount)),
    httpTimeoutSeconds: INTERCOM_REMOTE_GATEWAY_HTTP_TIMEOUT_SECONDS,
    historyTimeoutSeconds: INTERCOM_REMOTE_GATEWAY_HISTORY_TIMEOUT_SECONDS,
    gatewayPort: resolveRemoteGatewayPort(route),
    remoteCommand: resolveRemoteCommandPrefix(route),
    remoteCommandArgs: resolveRemoteCommandArgs(route),
    preferGatewayCli: true,
  }), 'utf8').toString('base64');
}

function buildPosixRemoteGatewayHistoryCommand(route: IntercomRoute, sessionId: string, beforeCount: number): string {
  const payloadBase64 = buildRemoteGatewayHistoryPayload(route, sessionId, beforeCount);
  const pythonScript = `
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

payload = json.loads(base64.b64decode(os.environ["KTCLAW_INTERCOM_GATEWAY_HISTORY_PAYLOAD_B64"]).decode("utf-8"))
gateway_port = int(payload.get("gatewayPort") or ${DEFAULT_REMOTE_GATEWAY_PORT})
gateway_url = "http://127.0.0.1:%d/rpc" % gateway_port
http_timeout = float(payload.get("httpTimeoutSeconds") or ${INTERCOM_REMOTE_GATEWAY_HTTP_TIMEOUT_SECONDS})
history_timeout = float(payload.get("historyTimeoutSeconds") or ${INTERCOM_REMOTE_GATEWAY_HISTORY_TIMEOUT_SECONDS})

${buildPythonGatewayRpcHelper()}

def rpc(method, params, timeout=None):
    return gateway_rpc(method, params, timeout or http_timeout)

def messages_from(value):
    if isinstance(value, dict):
        items = value.get("messages") or value.get("history")
        return items if isinstance(items, list) else []
    return value if isinstance(value, list) else []

def text_from_content(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                value = item.get("text") or item.get("content")
                if isinstance(value, str):
                    parts.append(value)
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts).strip()
    if isinstance(content, dict):
        value = content.get("text") or content.get("content")
        return value.strip() if isinstance(value, str) else ""
    return ""

try:
    session_key = payload["sessionKey"]
    before_count = int(payload.get("beforeCount") or 0)
    latest = messages_from(rpc("chat.history", {"sessionKey": session_key, "limit": 500}, history_timeout))
    new_messages = latest[before_count:] if len(latest) >= before_count else latest
    status = "running"
    for message in new_messages:
        if isinstance(message, dict) and message.get("role") == "assistant" and text_from_content(message.get("content")):
            status = "completed"
            break
    print(json.dumps({
        "messages": new_messages,
        "meta": {"via": "remote-gateway-poll", "status": status, "beforeCount": before_count, "sessionKey": session_key, "messageCount": len(latest)},
    }, ensure_ascii=False))
except Exception as exc:
    session_key = str(payload.get("sessionKey") or "")
    before_count = int(payload.get("beforeCount") or 0)
    print(json.dumps({
        "messages": [],
        "meta": {"via": "remote-gateway-poll", "status": "running", "beforeCount": before_count, "sessionKey": session_key, "messageCount": before_count, "warning": "history unavailable: %s" % exc},
    }, ensure_ascii=False))
    sys.exit(0)
`;
  const script = [
    `if command -v python3 >/dev/null 2>&1; then KTCLAW_INTERCOM_GATEWAY_HISTORY_PAYLOAD_B64=${quotePosix(payloadBase64)} python3 - <<'PY'`,
    pythonScript.trim(),
    'PY',
    'exit $?',
    'fi',
    'echo "Remote Gateway history unavailable: python3 not found" >&2',
    `exit ${INTERCOM_REMOTE_GATEWAY_FALLBACK_EXIT_CODE}`,
  ].join('\n');
  return `sh -lc ${quotePosix(script)}`;
}

function buildWindowsRemoteGatewayHistoryCommand(route: IntercomRoute, sessionId: string, beforeCount: number): string {
  const payloadBase64 = buildRemoteGatewayHistoryPayload(route, sessionId, beforeCount);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadBase64}')) | ConvertFrom-Json`,
    `$gatewayPort = if ($payload.PSObject.Properties.Name -contains "gatewayPort") { [int]$payload.gatewayPort } else { ${DEFAULT_REMOTE_GATEWAY_PORT} }`,
    `$historyTimeoutSec = if ($payload.PSObject.Properties.Name -contains "historyTimeoutSeconds") { [int]$payload.historyTimeoutSeconds } else { ${INTERCOM_REMOTE_GATEWAY_HISTORY_TIMEOUT_SECONDS} }`,
    '$gatewayUrl = "http://127.0.0.1:$gatewayPort/rpc"',
    ...buildPowerShellGatewayRpcHelper(),
    'function Invoke-KTClawGatewayRpc { param([string]$Method, $Params)',
    `return (Invoke-KTClawGatewaySmartRpc $Method $Params ${INTERCOM_REMOTE_GATEWAY_HTTP_TIMEOUT_SECONDS})`,
    '}',
    'function Get-KTClawMessages { param($Value) if ($null -eq $Value) { return @() }; if ($Value.PSObject.Properties.Name -contains "messages") { return @($Value.messages) }; if ($Value.PSObject.Properties.Name -contains "history") { return @($Value.history) }; if ($Value -is [array]) { return @($Value) }; return @() }',
    'function Get-KTClawText { param($Content) if ($null -eq $Content) { return "" }; if ($Content -is [string]) { return $Content.Trim() }; if ($Content -is [array]) { $parts = @(); foreach ($item in $Content) { if ($item -is [string]) { $parts += $item } elseif ($item.PSObject.Properties.Name -contains "text") { $parts += [string]$item.text } elseif ($item.PSObject.Properties.Name -contains "content") { $parts += [string]$item.content } }; return ([string]::Join("", $parts)).Trim() }; if ($Content.PSObject.Properties.Name -contains "text") { return ([string]$Content.text).Trim() }; if ($Content.PSObject.Properties.Name -contains "content") { return ([string]$Content.content).Trim() }; return "" }',
    'function Get-KTClawNewMessages { param($Messages, [int]$Start) $items = @($Messages); if ($items.Count -le $Start) { return @() }; return @($items[$Start..($items.Count - 1)]) }',
    '$beforeCount = [int]$payload.beforeCount',
    '$sessionKey = [string]$payload.sessionKey',
    '$historyWarning = $null',
    'try { $latest = @(Get-KTClawMessages (Invoke-KTClawGatewaySmartRpc "chat.history" @{ sessionKey = $sessionKey; limit = 500 } $historyTimeoutSec)) } catch { $historyWarning = "history unavailable: " + $_.Exception.Message; $latest = @() }',
    '$newMessages = if ($historyWarning) { @() } else { @(Get-KTClawNewMessages $latest $beforeCount) }',
    '$status = "running"',
    'foreach ($messageItem in $newMessages) { if (($messageItem.PSObject.Properties.Name -contains "role") -and $messageItem.role -eq "assistant" -and (Get-KTClawText $messageItem.content)) { $status = "completed"; break } }',
    '$messageCount = if ($historyWarning) { $beforeCount } else { $latest.Count }',
    '@{ messages = $newMessages; meta = @{ via = "remote-gateway-poll"; status = $status; beforeCount = $beforeCount; sessionKey = $sessionKey; messageCount = $messageCount; warning = $historyWarning } } | ConvertTo-Json -Depth 50 -Compress',
  ].join('; ');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

function shouldUseAutoRemoteCommand(route: IntercomRoute): boolean {
  return (route.remoteCommand || DEFAULT_REMOTE_OPENCLAW_COMMAND) === DEFAULT_REMOTE_OPENCLAW_COMMAND;
}

function buildPosixAutoOpenClawCommandPrefix(): string {
  const candidates = [
    '$HOME/.local/bin/openclaw',
    '$HOME/Desktop/claw/KTClaw/node_modules/.bin/openclaw',
    '$HOME/Desktop/KTClaw/node_modules/.bin/openclaw',
    '$HOME/Desktop/ClawX-main/node_modules/.bin/openclaw',
    '$HOME/桌面/claw/KTClaw/node_modules/.bin/openclaw',
    '$HOME/桌面/KTClaw/node_modules/.bin/openclaw',
    '$HOME/桌面/ClawX-main/node_modules/.bin/openclaw',
    '$HOME/Desktop/claw/KTClaw/resources/cli/posix/openclaw',
    '$HOME/桌面/claw/KTClaw/resources/cli/posix/openclaw',
  ];
  const script = [
    'set -eu',
    'if command -v openclaw >/dev/null 2>&1; then exec openclaw "$@"; fi',
    `for p in ${candidates.map((candidate) => `"${candidate.replace(/"/g, '\\"')}"`).join(' ')}; do if [ -x "$p" ]; then exec "$p" "$@"; fi; if [ -f "$p" ]; then exec sh "$p" "$@"; fi; done`,
    'if [ -x /opt/KTClaw/ktclaw ] && [ -f /opt/KTClaw/resources/openclaw/openclaw.mjs ]; then ELECTRON_RUN_AS_NODE=1 exec /opt/KTClaw/ktclaw /opt/KTClaw/resources/openclaw/openclaw.mjs "$@"; fi',
    'if [ -x /Applications/KTClaw.app/Contents/MacOS/KTClaw ] && [ -f /Applications/KTClaw.app/Contents/Resources/openclaw/openclaw.mjs ]; then ELECTRON_RUN_AS_NODE=1 exec /Applications/KTClaw.app/Contents/MacOS/KTClaw /Applications/KTClaw.app/Contents/Resources/openclaw/openclaw.mjs "$@"; fi',
    'echo "KTClaw/OpenClaw command not found. Install openclaw globally or set Remote OpenClaw command to the KTClaw/OpenClaw executable path." >&2',
    'exit 127',
  ].join('; ');
  return `sh -lc ${quotePosix(script)} ${quotePosix(KTCLAW_AUTO_REMOTE_LABEL)}`;
}

function resolveRemoteCommandPrefix(route: IntercomRoute): string {
  return shouldUseAutoRemoteCommand(route)
    ? buildPosixAutoOpenClawCommandPrefix()
    : (route.remoteCommand || DEFAULT_REMOTE_OPENCLAW_COMMAND);
}

function buildWindowsAutoOpenClawCommand(
  route: IntercomRoute,
  message: string,
  sessionId: string,
  options: { allowCliFallback?: boolean } = {},
): string {
  const remoteArgs = [
    'agent',
    '--local',
    '--to',
    buildIntercomSessionKey(route, sessionId),
    '--agent',
    route.agent,
    '--session-id',
    sessionId,
    '--message',
    message,
    '--json',
  ];
  const argsBase64 = Buffer.from(JSON.stringify(remoteArgs), 'utf-8').toString('base64');
  const gatewayPayloadBase64 = buildRemoteGatewayPayload(route, message, sessionId);
  const gatewaySendChildCommand = encodePowerShellCommand([
    "$ErrorActionPreference = 'Stop'",
    '$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:KTCLAW_INTERCOM_GATEWAY_PAYLOAD_B64)) | ConvertFrom-Json',
    `$gatewayPort = if ($payload.PSObject.Properties.Name -contains "gatewayPort") { [int]$payload.gatewayPort } else { ${DEFAULT_REMOTE_GATEWAY_PORT} }`,
    '$gatewayUrl = "http://127.0.0.1:$gatewayPort/rpc"',
    ...buildPowerShellGatewayRpcHelper(),
    'function Invoke-KTClawGatewayRpc { param([string]$Method, $Params, [int]$TimeoutSec)',
    'return (Invoke-KTClawGatewaySmartRpc $Method $Params $TimeoutSec)',
    '}',
    'function Write-KTClawRunLog { param($Value) try { $Value | ConvertTo-Json -Depth 50 -Compress | Set-Content -LiteralPath ([string]$payload.runLog) -Encoding UTF8 } catch {} }',
    'try {',
    '$timeout = if ($payload.PSObject.Properties.Name -contains "sendHttpTimeoutSeconds") { [int]$payload.sendHttpTimeoutSeconds } else { 180 }',
    '$result = Invoke-KTClawGatewayRpc "chat.send" @{ sessionKey = [string]$payload.sessionKey; message = [string]$payload.message; deliver = $false; idempotencyKey = [string]$payload.idempotencyKey } $timeout',
    'Write-KTClawRunLog @{ ok = $true; result = $result }',
    '} catch {',
    'Write-KTClawRunLog @{ ok = $false; error = $_.Exception.Message }',
    '}',
  ].join('; '));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$argsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${argsBase64}'))`,
    '$openclawArgs = @($argsJson | ConvertFrom-Json)',
    '$gatewayStarted = $false',
    'try {',
    `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${gatewayPayloadBase64}')) | ConvertFrom-Json`,
    `$gatewayPort = if ($payload.PSObject.Properties.Name -contains "gatewayPort") { [int]$payload.gatewayPort } else { ${DEFAULT_REMOTE_GATEWAY_PORT} }`,
    `$historyTimeoutSec = if ($payload.PSObject.Properties.Name -contains "historyTimeoutSeconds") { [int]$payload.historyTimeoutSeconds } else { ${INTERCOM_REMOTE_GATEWAY_HISTORY_TIMEOUT_SECONDS} }`,
    '$gatewayUrl = "http://127.0.0.1:$gatewayPort/rpc"',
    ...buildPowerShellGatewayRpcHelper(),
    'function Invoke-KTClawGatewayRpc { param([string]$Method, $Params)',
    `return (Invoke-KTClawGatewaySmartRpc $Method $Params ${INTERCOM_REMOTE_GATEWAY_HTTP_TIMEOUT_SECONDS})`,
    '}',
    'function Get-KTClawMessages { param($Value) if ($null -eq $Value) { return @() }; if ($Value.PSObject.Properties.Name -contains "messages") { return @($Value.messages) }; if ($Value.PSObject.Properties.Name -contains "history") { return @($Value.history) }; if ($Value -is [array]) { return @($Value) }; return @() }',
    'function Get-KTClawText { param($Content) if ($null -eq $Content) { return "" }; if ($Content -is [string]) { return $Content.Trim() }; if ($Content -is [array]) { $parts = @(); foreach ($item in $Content) { if ($item -is [string]) { $parts += $item } elseif ($item.PSObject.Properties.Name -contains "text") { $parts += [string]$item.text } elseif ($item.PSObject.Properties.Name -contains "content") { $parts += [string]$item.content } }; return ([string]::Join("", $parts)).Trim() }; if ($Content.PSObject.Properties.Name -contains "text") { return ([string]$Content.text).Trim() }; if ($Content.PSObject.Properties.Name -contains "content") { return ([string]$Content.content).Trim() }; return "" }',
    'function Get-KTClawNewMessages { param($Messages, [int]$Start) $items = @($Messages); if ($items.Count -le $Start) { return @() }; return @($items[$Start..($items.Count - 1)]) }',
    '$historyParams = @{ sessionKey = [string]$payload.sessionKey; limit = 500 }',
    '$historyWarning = $null',
    'try { $before = @(Get-KTClawMessages (Invoke-KTClawGatewaySmartRpc "chat.history" $historyParams $historyTimeoutSec)) } catch { $historyWarning = "pre-send history unavailable: " + $_.Exception.Message; $before = @() }',
    '$beforeCount = $before.Count',
    "$runDir = Join-Path $HOME '.ktclaw\\intercom\\gateway-runs'",
    'New-Item -ItemType Directory -Force -Path $runDir | Out-Null',
    '$runLog = Join-Path $runDir ((([string]$payload.idempotencyKey) -replace "[\\\\/:*?`"<>|]", "_") + ".json")',
    '$childPayload = @{ sessionKey = [string]$payload.sessionKey; message = [string]$payload.message; idempotencyKey = [string]$payload.idempotencyKey; runLog = $runLog; sendHttpTimeoutSeconds = [int]$payload.sendHttpTimeoutSeconds; gatewayPort = [int]$payload.gatewayPort; preferGatewayCli = $true } | ConvertTo-Json -Depth 20 -Compress',
    '$env:KTCLAW_INTERCOM_GATEWAY_PAYLOAD_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($childPayload))',
    `Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", "${gatewaySendChildCommand}") -WindowStyle Hidden`,
    '$gatewayStarted = $true',
    '$deadline = [DateTime]::UtcNow.AddSeconds([double]$payload.timeoutSeconds)',
    '$latest = $before',
    'while ([DateTime]::UtcNow -lt $deadline) {',
    'Start-Sleep -Seconds 1',
    'try { $latest = @(Get-KTClawMessages (Invoke-KTClawGatewaySmartRpc "chat.history" $historyParams $historyTimeoutSec)) } catch { $historyWarning = "post-send history unavailable: " + $_.Exception.Message; break }',
    '$newMessages = @(Get-KTClawNewMessages $latest $beforeCount)',
    'foreach ($messageItem in $newMessages) { if (($messageItem.PSObject.Properties.Name -contains "role") -and $messageItem.role -eq "assistant" -and (Get-KTClawText $messageItem.content)) { @{ messages = $newMessages; result = @{ dispatched = $true; runLog = $runLog }; meta = @{ via = "remote-gateway"; status = "completed"; beforeCount = $beforeCount; sessionKey = [string]$payload.sessionKey; messageCount = $latest.Count; warning = $historyWarning } } | ConvertTo-Json -Depth 50 -Compress; exit 0 } }',
    '}',
    '$remaining = @(Get-KTClawNewMessages $latest $beforeCount)',
    '@{ messages = $remaining; result = @{ dispatched = $true; runLog = $runLog }; meta = @{ via = "remote-gateway"; status = "running"; beforeCount = $beforeCount; sessionKey = [string]$payload.sessionKey; messageCount = $latest.Count; warning = $historyWarning } } | ConvertTo-Json -Depth 50 -Compress',
    'exit 0',
    '} catch {',
    'if ($gatewayStarted) { @{ messages = @(@{ role = "assistant"; content = ("Remote Gateway run failed: " + $_.Exception.Message) }); meta = @{ via = "remote-gateway"; error = $_.Exception.Message } } | ConvertTo-Json -Depth 20 -Compress; exit 0 }',
    '}',
    ...(options.allowCliFallback === false
      ? [
        'Write-Error "Remote Gateway is unavailable on $gatewayUrl. Open KTClaw on the remote machine, confirm its Gateway port matches this route, and keep Gateway running; normal Intercom messages no longer cold-start openclaw agent automatically."',
        `exit ${INTERCOM_REMOTE_GATEWAY_FALLBACK_EXIT_CODE}`,
      ]
      : []),
    '$cmd = Get-Command openclaw -ErrorAction SilentlyContinue',
    'if ($cmd) { & $cmd.Source @openclawArgs; exit $LASTEXITCODE }',
    '$candidatePaths = @(',
    '  (Join-Path (Get-Location) "node_modules\\.bin\\openclaw.cmd"),',
    '  (Join-Path (Get-Location) "resources\\cli\\win32\\openclaw.cmd"),',
    '  "$env:USERPROFILE\\Desktop\\claw\\KTClaw\\node_modules\\.bin\\openclaw.cmd",',
    '  "$env:USERPROFILE\\Desktop\\KTClaw\\node_modules\\.bin\\openclaw.cmd",',
    '  "$env:USERPROFILE\\Desktop\\ClawX-main\\node_modules\\.bin\\openclaw.cmd",',
    '  "$env:LOCALAPPDATA\\Programs\\KTClaw\\resources\\cli\\win32\\openclaw.cmd",',
    '  "$env:ProgramFiles\\KTClaw\\resources\\cli\\win32\\openclaw.cmd"',
    ')',
    'foreach ($path in $candidatePaths) { if ($path -and (Test-Path -LiteralPath $path)) { & $path @openclawArgs; exit $LASTEXITCODE } }',
    '$electronEntries = @(',
    '  @{ Exe = "$env:LOCALAPPDATA\\Programs\\KTClaw\\KTClaw.exe"; Mjs = "$env:LOCALAPPDATA\\Programs\\KTClaw\\resources\\openclaw\\openclaw.mjs" },',
    '  @{ Exe = "$env:ProgramFiles\\KTClaw\\KTClaw.exe"; Mjs = "$env:ProgramFiles\\KTClaw\\resources\\openclaw\\openclaw.mjs" }',
    ')',
    'foreach ($entry in $electronEntries) { if ((Test-Path -LiteralPath $entry.Exe) -and (Test-Path -LiteralPath $entry.Mjs)) { $env:ELECTRON_RUN_AS_NODE = "1"; & $entry.Exe $entry.Mjs @openclawArgs; exit $LASTEXITCODE } }',
    'Write-Error "KTClaw/OpenClaw command not found. Install openclaw globally or set Remote OpenClaw command to the KTClaw/OpenClaw executable path."',
    'exit 127',
  ].join('; ');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

function normalizeDirectTaskAction(action: string): 'screenshot' | 'camera' | null {
  const normalized = action.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 'screenshot' || normalized === 'screen_capture' || normalized === 'capture_screen') {
    return 'screenshot';
  }
  if (normalized === 'camera' || normalized === 'photo' || normalized === 'take_photo' || normalized === 'camera_photo') {
    return 'camera';
  }
  return null;
}

interface DirectInboxFile {
  name: string;
  path: string;
  mimeType: string;
  size?: number;
}

function normalizeDirectInboxFiles(task: IntercomRemoteTaskRequest): DirectInboxFile[] {
  const value = task.payload.inboxFiles;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry): DirectInboxFile | null => {
      if (!isRecord(entry)) {
        return null;
      }
      const path = normalizeRemotePath(normalizeString(entry.path ?? entry.remotePath));
      if (!path) {
        return null;
      }
      const name = normalizeString(entry.name ?? entry.fileName) || basename(path);
      const mimeType = normalizeString(entry.mimeType ?? entry.mime) || getMimeType(path);
      const size = typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : undefined;
      return { name, path, mimeType, size };
    })
    .filter((entry): entry is DirectInboxFile => Boolean(entry));
}

function isDirectTextPreviewFile(file: DirectInboxFile): boolean {
  const extension = extname(file.path || file.name).toLowerCase();
  return DIRECT_FILE_INSPECT_EXTENSIONS.has(extension)
    || file.mimeType.startsWith('text/')
    || /(?:json|xml|yaml|csv|markdown|javascript|typescript|python|shell|sql)/i.test(file.mimeType);
}

function shouldUseDirectInboxFileInspection(task: IntercomRemoteTaskRequest): boolean {
  if (normalizeString(task.action).toLowerCase() !== 'remote_task') {
    return false;
  }
  const files = normalizeDirectInboxFiles(task);
  if (files.length === 0 || !files.some(isDirectTextPreviewFile)) {
    return false;
  }
  const instruction = readTaskPayloadString(task, 'instruction');
  if (!instruction) {
    return true;
  }
  return /内容|查看|看看|读取|读一下|总结|摘要|预览|inspect|read|content|what|summary|summar/i.test(instruction);
}

function buildPosixInboxFileInspectionCommand(task: IntercomRemoteTaskRequest): string {
  const files = normalizeDirectInboxFiles(task).slice(0, 8);
  const instruction = readTaskPayloadString(task, 'instruction');
  const textExtensions = Array.from(DIRECT_FILE_INSPECT_EXTENSIONS)
    .map((extension) => `*${extension}`)
    .join('|');
  const script = [
    'set -eu',
    `limit=${INTERCOM_DIRECT_FILE_PREVIEW_CHARS}`,
    `printf '%s\\n' ${quotePosix('Uploaded file inspection completed through SSH fast path.')}`,
    instruction ? `printf 'Instruction: %s\\n' ${quotePosix(instruction)}` : '',
    ...files.flatMap((file) => {
      const textPreview = isDirectTextPreviewFile(file);
      const name = file.name || basename(file.path);
      const previewCommand = [
        `printf '\\n\`\`\`text\\n'`,
        'head -c "$limit" "$path" || true',
        `printf '\\n\`\`\`\\n'`,
        'if [ "${size:-0}" -gt "$limit" ] 2>/dev/null; then printf "... truncated to %s characters\\n" "$limit"; fi',
      ].join('; ');
      return [
        `path=${quotePosixRemotePath(file.path)}`,
        `name=${quotePosix(name)}`,
        `mime=${quotePosix(file.mimeType)}`,
        `printf '\\n## %s\\n' "$name"`,
        `printf 'Path: %s\\n' "$path"`,
        'if [ -f "$path" ]; then '
          + 'size=$(wc -c < "$path" | tr -d "[:space:]" || printf 0); '
          + 'printf "Size: %s bytes\\n" "$size"; '
          + (textPreview
            ? previewCommand
            : `case "$path" in ${textExtensions}) ${previewCommand} ;; *) printf 'This file is not a supported text preview type (%s).\\n' "$mime" ;; esac`)
          + '; else printf "File not found on remote machine.\\n"; fi',
      ];
    }),
  ].filter(Boolean).join('; ');
  return `sh -lc ${quotePosix(script)}`;
}

function buildWindowsInboxFileInspectionCommand(task: IntercomRemoteTaskRequest): string {
  const filesJson = JSON.stringify(normalizeDirectInboxFiles(task).slice(0, 8));
  const filesJsonBase64 = Buffer.from(filesJson, 'utf8').toString('base64');
  const instruction = readTaskPayloadString(task, 'instruction');
  const textExtensionsRegex = Array.from(DIRECT_FILE_INSPECT_EXTENSIONS)
    .map((extension) => extension.replace('.', '\\.'))
    .join('|');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$limit = ${INTERCOM_DIRECT_FILE_PREVIEW_CHARS}`,
    `$files = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${filesJsonBase64}')) | ConvertFrom-Json`,
    `Write-Output ${JSON.stringify('Uploaded file inspection completed through SSH fast path.')}`,
    instruction ? `Write-Output ${JSON.stringify(`Instruction: ${instruction}`)}` : '',
    'foreach ($file in @($files)) {',
    '$path = [string]$file.path',
    "if ($path.StartsWith('~/')) { $path = Join-Path $HOME ($path.Substring(2).Replace('/', '\\')) } else { $path = $path.Replace('/', '\\') }",
    'Write-Output ""',
    'Write-Output ("## " + [string]$file.name)',
    'Write-Output ("Path: " + $path)',
    'if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Write-Output "File not found on remote machine."; continue }',
    '$item = Get-Item -LiteralPath $path',
    'Write-Output ("Size: " + $item.Length + " bytes")',
    `$isText = ([string]$file.mimeType -match '^(text/)|json|xml|yaml|csv|markdown|javascript|typescript|python|shell|sql') -or ($path -match '(${textExtensionsRegex})$')`,
    'if (-not $isText) { Write-Output ("This file is not a supported text preview type (" + [string]$file.mimeType + ")."); continue }',
    '$text = Get-Content -LiteralPath $path -Raw -ErrorAction Stop',
    '$truncated = $false',
    'if ($text.Length -gt $limit) { $text = $text.Substring(0, $limit); $truncated = $true }',
    'Write-Output "```text"',
    'Write-Output $text',
    'Write-Output "```"',
    'if ($truncated) { Write-Output ("... truncated to " + $limit + " characters") }',
    '}',
  ].filter(Boolean).join('; ');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

function readTaskPayloadString(task: IntercomRemoteTaskRequest, key: string): string {
  const value = task.payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeOutboxPath(value: string, taskId: string): string {
  const fallback = `${INTERCOM_REMOTE_BASE_DIR}/outbox/${safeRemotePathPart(taskId, 'task')}/`;
  const normalized = normalizeRemotePath(value || fallback).replace(/\/+$/, '');
  return normalized || fallback.replace(/\/+$/, '');
}

function joinRemotePath(dir: string, fileName: string): string {
  return `${normalizeRemotePath(dir).replace(/\/+$/, '')}/${safeRemotePathPart(fileName, 'artifact')}`;
}

function remotePowerShellHomePath(value: string): string {
  const normalized = normalizeRemotePath(value);
  if (normalized.startsWith('~/')) {
    return `$HOME/${normalized.slice(2).replace(/\//g, '\\')}`;
  }
  return normalized.replace(/\//g, '\\');
}

function buildDirectTaskResultJson(result: IntercomRemoteTaskResult): string {
  return JSON.stringify(result);
}

function shellNonEmptyFileTest(pathVariable = '$artifact'): string {
  return `[ -s "${pathVariable}" ]`;
}

function powerShellNonEmptyFileTest(pathVariable = '$artifact'): string {
  return `(Test-Path -LiteralPath ${pathVariable} -PathType Leaf) -and ((Get-Item -LiteralPath ${pathVariable}).Length -gt 0)`;
}

function buildDesktopCameraRequest(task: IntercomRemoteTaskRequest): {
  requestId: string;
  taskId: string;
  artifactPath: string;
  acceptedPath: string;
  resultPath: string;
  requestJson: string;
} {
  const outbox = normalizeOutboxPath(readTaskPayloadString(task, 'outbox'), task.taskId);
  const format = readTaskPayloadString(task, 'format').toLowerCase() === 'png' ? 'png' : 'jpg';
  const artifactPath = joinRemotePath(outbox, `camera.${format}`);
  const acceptedPath = joinRemotePath(outbox, 'desktop-camera-accepted.json');
  const resultPath = joinRemotePath(outbox, 'desktop-camera-result.json');
  const requestId = `camera-${safeRemotePathPart(task.taskId, 'task')}-${randomUUID().slice(0, 8)}`;
  const reason = readTaskPayloadString(task, 'reason') || readTaskPayloadString(task, 'instruction');
  return {
    requestId,
    taskId: task.taskId,
    artifactPath,
    acceptedPath,
    resultPath,
    requestJson: JSON.stringify({
      requestId,
      taskId: task.taskId,
      artifactPath,
      acceptedPath,
      resultPath,
      reason,
      requestedAt: Date.now(),
    }),
  };
}

function buildDesktopScreenshotRequest(task: IntercomRemoteTaskRequest): {
  requestId: string;
  taskId: string;
  artifactPath: string;
  acceptedPath: string;
  resultPath: string;
  requestJson: string;
} {
  const outbox = normalizeOutboxPath(readTaskPayloadString(task, 'outbox'), task.taskId);
  const artifactPath = joinRemotePath(outbox, 'screenshot.png');
  const acceptedPath = joinRemotePath(outbox, 'desktop-screenshot-accepted.json');
  const resultPath = joinRemotePath(outbox, 'desktop-screenshot-result.json');
  const requestId = `screenshot-${safeRemotePathPart(task.taskId, 'task')}-${randomUUID().slice(0, 8)}`;
  const reason = readTaskPayloadString(task, 'reason') || readTaskPayloadString(task, 'instruction');
  return {
    requestId,
    taskId: task.taskId,
    artifactPath,
    acceptedPath,
    resultPath,
    requestJson: JSON.stringify({
      requestId,
      taskId: task.taskId,
      artifactPath,
      acceptedPath,
      resultPath,
      reason,
      requestedAt: Date.now(),
    }),
  };
}

function buildPosixDesktopCameraCommand(task: IntercomRemoteTaskRequest): string {
  const request = buildDesktopCameraRequest(task);
  const requestDir = `${INTERCOM_REMOTE_BASE_DIR}/desktop-camera-requests`;
  const script = [
    'set -eu',
    `request_dir=${quotePosixRemotePath(requestDir)}`,
    `accepted_path=${quotePosixRemotePath(request.acceptedPath)}`,
    `result_path=${quotePosixRemotePath(request.resultPath)}`,
    'mkdir -p "$request_dir" "${result_path%/*}"',
    'rm -f "$accepted_path" "$result_path"',
    `printf %s ${quotePosix(request.requestJson)} > "$request_dir/${safeRemotePathPart(request.requestId, 'request')}.json"`,
    `i=0; while [ "$i" -lt ${INTERCOM_DESKTOP_CAMERA_ACCEPT_WAIT_SECONDS} ]; do if [ -f "$accepted_path" ]; then break; fi; sleep 1; i=$((i+1)); done`,
    `if [ ! -f "$accepted_path" ]; then echo "KTClaw desktop camera UI did not accept within ${INTERCOM_DESKTOP_CAMERA_ACCEPT_WAIT_SECONDS}s" >&2; exit 86; fi`,
    `i=0; while [ "$i" -lt ${INTERCOM_DESKTOP_CAMERA_WAIT_SECONDS} ]; do if [ -f "$result_path" ]; then cat "$result_path"; exit 0; fi; sleep 1; i=$((i+1)); done`,
    `echo "KTClaw desktop camera UI did not respond within ${INTERCOM_DESKTOP_CAMERA_WAIT_SECONDS}s" >&2`,
    'exit 86',
  ].join('; ');
  return `sh -lc ${quotePosix(script)}`;
}

function buildPosixDesktopScreenshotCommand(task: IntercomRemoteTaskRequest): string {
  const request = buildDesktopScreenshotRequest(task);
  const requestDir = `${INTERCOM_REMOTE_BASE_DIR}/desktop-screenshot-requests`;
  const script = [
    'set -eu',
    `request_dir=${quotePosixRemotePath(requestDir)}`,
    `accepted_path=${quotePosixRemotePath(request.acceptedPath)}`,
    `result_path=${quotePosixRemotePath(request.resultPath)}`,
    'mkdir -p "$request_dir" "${result_path%/*}"',
    'rm -f "$accepted_path" "$result_path"',
    `printf %s ${quotePosix(request.requestJson)} > "$request_dir/${safeRemotePathPart(request.requestId, 'request')}.json"`,
    `i=0; while [ "$i" -lt ${INTERCOM_DESKTOP_SCREENSHOT_ACCEPT_WAIT_SECONDS} ]; do if [ -f "$accepted_path" ]; then break; fi; sleep 1; i=$((i+1)); done`,
    `if [ ! -f "$accepted_path" ]; then echo "KTClaw desktop screenshot service did not accept within ${INTERCOM_DESKTOP_SCREENSHOT_ACCEPT_WAIT_SECONDS}s" >&2; exit 86; fi`,
    `i=0; while [ "$i" -lt ${INTERCOM_DESKTOP_SCREENSHOT_WAIT_SECONDS} ]; do if [ -f "$result_path" ]; then cat "$result_path"; exit 0; fi; sleep 1; i=$((i+1)); done`,
    `echo "KTClaw desktop screenshot service did not respond within ${INTERCOM_DESKTOP_SCREENSHOT_WAIT_SECONDS}s" >&2`,
    'exit 86',
  ].join('; ');
  return `sh -lc ${quotePosix(script)}`;
}

function buildWindowsDesktopCameraCommand(task: IntercomRemoteTaskRequest): string {
  const request = buildDesktopCameraRequest(task);
  const requestJsonBase64 = Buffer.from(request.requestJson, 'utf8').toString('base64');
  const requestFileName = `${safeRemotePathPart(request.requestId, 'request')}.json`;
  const acceptedPath = remotePowerShellHomePath(request.acceptedPath);
  const resultPath = remotePowerShellHomePath(request.resultPath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$requestDir = Join-Path $HOME '.ktclaw\\intercom\\desktop-camera-requests'",
    `$acceptedPath = ${JSON.stringify(acceptedPath)}`,
    `$resultPath = ${JSON.stringify(resultPath)}`,
    'New-Item -ItemType Directory -Force -Path $requestDir | Out-Null',
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resultPath) | Out-Null',
    'Remove-Item -LiteralPath $acceptedPath,$resultPath -Force -ErrorAction SilentlyContinue',
    `$requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${requestJsonBase64}'))`,
    `[IO.File]::WriteAllText((Join-Path $requestDir ${JSON.stringify(requestFileName)}), $requestJson, [Text.Encoding]::UTF8)`,
    `for ($i = 0; $i -lt ${INTERCOM_DESKTOP_CAMERA_ACCEPT_WAIT_SECONDS}; $i++) { if (Test-Path -LiteralPath $acceptedPath) { break }; Start-Sleep -Seconds 1 }`,
    `if (-not (Test-Path -LiteralPath $acceptedPath)) { Write-Error "KTClaw desktop camera UI did not accept within ${INTERCOM_DESKTOP_CAMERA_ACCEPT_WAIT_SECONDS}s"; exit 86 }`,
    `for ($i = 0; $i -lt ${INTERCOM_DESKTOP_CAMERA_WAIT_SECONDS}; $i++) { if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath -Raw; exit 0 }; Start-Sleep -Seconds 1 }`,
    `Write-Error "KTClaw desktop camera UI did not respond within ${INTERCOM_DESKTOP_CAMERA_WAIT_SECONDS}s"`,
    'exit 86',
  ].join('; ');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

function buildWindowsDesktopScreenshotCommand(task: IntercomRemoteTaskRequest): string {
  const request = buildDesktopScreenshotRequest(task);
  const requestJsonBase64 = Buffer.from(request.requestJson, 'utf8').toString('base64');
  const requestFileName = `${safeRemotePathPart(request.requestId, 'request')}.json`;
  const acceptedPath = remotePowerShellHomePath(request.acceptedPath);
  const resultPath = remotePowerShellHomePath(request.resultPath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$requestDir = Join-Path $HOME '.ktclaw\\intercom\\desktop-screenshot-requests'",
    `$acceptedPath = ${JSON.stringify(acceptedPath)}`,
    `$resultPath = ${JSON.stringify(resultPath)}`,
    'New-Item -ItemType Directory -Force -Path $requestDir | Out-Null',
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resultPath) | Out-Null',
    'Remove-Item -LiteralPath $acceptedPath,$resultPath -Force -ErrorAction SilentlyContinue',
    `$requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${requestJsonBase64}'))`,
    `[IO.File]::WriteAllText((Join-Path $requestDir ${JSON.stringify(requestFileName)}), $requestJson, [Text.Encoding]::UTF8)`,
    `for ($i = 0; $i -lt ${INTERCOM_DESKTOP_SCREENSHOT_ACCEPT_WAIT_SECONDS}; $i++) { if (Test-Path -LiteralPath $acceptedPath) { break }; Start-Sleep -Seconds 1 }`,
    `if (-not (Test-Path -LiteralPath $acceptedPath)) { Write-Error "KTClaw desktop screenshot service did not accept within ${INTERCOM_DESKTOP_SCREENSHOT_ACCEPT_WAIT_SECONDS}s"; exit 86 }`,
    `for ($i = 0; $i -lt ${INTERCOM_DESKTOP_SCREENSHOT_WAIT_SECONDS}; $i++) { if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath -Raw; exit 0 }; Start-Sleep -Seconds 1 }`,
    `Write-Error "KTClaw desktop screenshot service did not respond within ${INTERCOM_DESKTOP_SCREENSHOT_WAIT_SECONDS}s"`,
    'exit 86',
  ].join('; ');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

function buildPosixScreenshotCommand(task: IntercomRemoteTaskRequest): string {
  const outbox = normalizeOutboxPath(readTaskPayloadString(task, 'outbox'), task.taskId);
  const artifactPath = joinRemotePath(outbox, 'screenshot.png');
  const successJson = buildDirectTaskResultJson({
    success: true,
    summary: 'Screenshot captured.',
    artifacts: [{ type: 'image', path: artifactPath, name: 'screenshot.png', mimeType: 'image/png' }],
    logs: 'Captured through SSH direct screenshot fast path.',
    error: null,
  });
  const failureJson = buildDirectTaskResultJson({
    success: false,
    summary: '',
    artifacts: [],
    logs: 'No supported screenshot utility produced a readable image on the remote machine.',
    error: 'No supported screenshot utility produced a readable image. Install gnome-screenshot, grim, scrot, ImageMagick import, or run KTClaw in an interactive desktop session.',
  });
  const script = [
    'set -eu',
    `artifact=${quotePosixRemotePath(artifactPath)}`,
    'mkdir -p "${artifact%/*}"',
    'if command -v screencapture >/dev/null 2>&1; then screencapture -x "$artifact";',
    'elif command -v gnome-screenshot >/dev/null 2>&1; then gnome-screenshot -f "$artifact";',
    'elif command -v grim >/dev/null 2>&1; then grim "$artifact";',
    'elif command -v scrot >/dev/null 2>&1; then scrot "$artifact";',
    'elif command -v import >/dev/null 2>&1; then import -window root "$artifact";',
    `else printf '%s\\n' ${quotePosix(failureJson)}; exit 0; fi`,
    `if ${shellNonEmptyFileTest()}; then printf '%s\\n' ${quotePosix(successJson)}; else rm -f "$artifact"; printf '%s\\n' ${quotePosix(failureJson)}; fi`,
  ].join(' ');
  return `sh -lc ${quotePosix(script)}`;
}

function buildPosixCameraToolCommand(task: IntercomRemoteTaskRequest): string {
  const outbox = normalizeOutboxPath(readTaskPayloadString(task, 'outbox'), task.taskId);
  const format = readTaskPayloadString(task, 'format').toLowerCase() === 'png' ? 'png' : 'jpg';
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const artifactPath = joinRemotePath(outbox, `camera.${format}`);
  const successJson = buildDirectTaskResultJson({
    success: true,
    summary: 'Camera photo captured.',
    artifacts: [{ type: 'image', path: artifactPath, name: `camera.${format}`, mimeType }],
    logs: 'Captured through SSH direct camera tool fallback.',
    error: null,
  });
  const failureJson = buildDirectTaskResultJson({
    success: false,
    summary: '',
    artifacts: [],
    logs: 'KTClaw desktop camera UI did not respond and no supported camera utility produced a readable image.',
    error: 'No supported camera utility produced a readable image. Install imagesnap, fswebcam, or ffmpeg, or keep the KTClaw desktop client open.',
  });
  const script = [
    'set -eu',
    `artifact=${quotePosixRemotePath(artifactPath)}`,
    'mkdir -p "${artifact%/*}"',
    'if command -v imagesnap >/dev/null 2>&1; then imagesnap "$artifact" >/dev/null;',
    'elif command -v fswebcam >/dev/null 2>&1; then fswebcam --no-banner "$artifact" >/dev/null;',
    'elif command -v ffmpeg >/dev/null 2>&1; then if [ "$(uname -s)" = "Darwin" ]; then ffmpeg -hide_banner -loglevel error -f avfoundation -i "0" -frames:v 1 -y "$artifact"; else ffmpeg -hide_banner -loglevel error -f v4l2 -i "${KTCLAW_CAMERA_DEVICE:-/dev/video0}" -frames:v 1 -y "$artifact"; fi;',
    `else printf '%s\\n' ${quotePosix(failureJson)}; exit 0; fi`,
    `if ${shellNonEmptyFileTest()}; then printf '%s\\n' ${quotePosix(successJson)}; else rm -f "$artifact"; printf '%s\\n' ${quotePosix(failureJson)}; fi`,
  ].join(' ');
  return `sh -lc ${quotePosix(script)}`;
}

function buildWindowsScreenshotCommand(task: IntercomRemoteTaskRequest): string {
  const outbox = normalizeOutboxPath(readTaskPayloadString(task, 'outbox'), task.taskId);
  const artifactPath = joinRemotePath(outbox, 'screenshot.png');
  const artifactPowerShellPath = remotePowerShellHomePath(artifactPath);
  const successJson = buildDirectTaskResultJson({
    success: true,
    summary: 'Screenshot captured.',
    artifacts: [{ type: 'image', path: artifactPath, name: 'screenshot.png', mimeType: 'image/png' }],
    logs: 'Captured through Windows desktop screenshot fast path.',
    error: null,
  });
  const failureJson = buildDirectTaskResultJson({
    success: false,
    summary: '',
    artifacts: [],
    logs: 'Windows screenshot capture failed. SSH sessions may not have access to the interactive desktop.',
    error: 'Windows screenshot capture failed or produced an empty image. Keep KTClaw desktop open or run the task in an interactive desktop session.',
  });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$artifact = ${JSON.stringify(artifactPowerShellPath)}`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $artifact) | Out-Null',
    'try {',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    '$bitmap.Save($artifact, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$graphics.Dispose(); $bitmap.Dispose()',
    `if (${powerShellNonEmptyFileTest()}) { ${JSON.stringify(successJson)} } else { Remove-Item -LiteralPath $artifact -Force -ErrorAction SilentlyContinue; ${JSON.stringify(failureJson)} }`,
    '} catch {',
    `${JSON.stringify(failureJson)}`,
    '}',
  ].join('; ');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

function buildWindowsCameraToolCommand(task: IntercomRemoteTaskRequest): string {
  const outbox = normalizeOutboxPath(readTaskPayloadString(task, 'outbox'), task.taskId);
  const format = readTaskPayloadString(task, 'format').toLowerCase() === 'png' ? 'png' : 'jpg';
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const artifactPath = joinRemotePath(outbox, `camera.${format}`);
  const artifactPowerShellPath = remotePowerShellHomePath(artifactPath);
  const successJson = buildDirectTaskResultJson({
    success: true,
    summary: 'Camera photo captured.',
    artifacts: [{ type: 'image', path: artifactPath, name: `camera.${format}`, mimeType }],
    logs: 'Captured through Windows ffmpeg camera fallback.',
    error: null,
  });
  const failureJson = buildDirectTaskResultJson({
    success: false,
    summary: '',
    artifacts: [],
    logs: 'KTClaw desktop camera UI did not respond and ffmpeg camera capture was unavailable.',
    error: 'No supported Windows camera fallback produced a readable image. Install ffmpeg or keep the KTClaw desktop client open.',
  });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$artifact = ${JSON.stringify(artifactPowerShellPath)}`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $artifact) | Out-Null',
    '$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue',
    `if (-not $ffmpeg) { ${JSON.stringify(failureJson)}; exit 0 }`,
    '$devices = & $ffmpeg.Source -hide_banner -list_devices true -f dshow -i dummy 2>&1 | Out-String',
    `$match = [regex]::Match($devices, '"([^"]+)"\\s+\\(video\\)')`,
    `if (-not $match.Success) { ${JSON.stringify(failureJson)}; exit 0 }`,
    '$device = $match.Groups[1].Value',
    '& $ffmpeg.Source -hide_banner -loglevel error -f dshow -i "video=$device" -frames:v 1 -y $artifact',
    `if (${powerShellNonEmptyFileTest()}) { ${JSON.stringify(successJson)} } else { Remove-Item -LiteralPath $artifact -Force -ErrorAction SilentlyContinue; ${JSON.stringify(failureJson)} }`,
  ].join('; ');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

function getIntercomErrorText(error: unknown): string {
  const row = error && typeof error === 'object' ? error as { stdout?: unknown; stderr?: unknown } : {};
  const message = error instanceof Error ? error.message : String(error);
  return [
    message,
    typeof row.stdout === 'string' ? row.stdout : '',
    typeof row.stderr === 'string' ? row.stderr : '',
  ].filter(Boolean).join('\n');
}

function shouldRetryWithAutoRemoteDiscovery(route: IntercomRoute, error: unknown): boolean {
  if (route.transport !== 'ssh') {
    return false;
  }
  if (!shouldUseAutoRemoteCommand(route)) {
    return false;
  }
  const normalized = getIntercomErrorText(error).toLowerCase();
  if (normalized.includes('openclaw') || normalized.includes('ktclaw')) {
    return false;
  }
  return normalized.includes('sh: command not found')
    || normalized.includes('sh: not found')
    || normalized.includes('sh : the term')
    || normalized.includes("'sh' is not recognized")
    || normalized.includes('openclaw：未找到命令')
    || normalized.includes("'sh' is not recognized");
}

function withBundledLinuxOpenClawCommand(route: IntercomRoute): IntercomRoute {
  return {
    ...route,
    remoteCommand: KTCLAW_LINUX_REMOTE_OPENCLAW_COMMAND,
  };
}

function isIntercomTextOnlyImageSchemaFailure(value: unknown): boolean {
  if (typeof value === 'string') {
    return isTextOnlyImageSchemaError(value);
  }
  if (value instanceof Error) {
    const row = value as { stdout?: unknown; stderr?: unknown };
    return isTextOnlyImageSchemaError([
      value.message,
      typeof row.stdout === 'string' ? row.stdout : '',
      typeof row.stderr === 'string' ? row.stderr : '',
    ].filter(Boolean).join('\n'));
  }
  if (isRecord(value)) {
    return isTextOnlyImageSchemaError([
      typeof value.stdout === 'string' ? value.stdout : '',
      typeof value.stderr === 'string' ? value.stderr : '',
      typeof value.error === 'string' ? value.error : '',
    ].filter(Boolean).join('\n'));
  }
  return false;
}

function isIntercomResetCommand(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === '/new' || normalized === '/reset';
}

function buildCleanIntercomSessionId(sessionId: string): string {
  const base = safeRemotePathPart(normalizeString(sessionId) || DEFAULT_SESSION_ID, DEFAULT_SESSION_ID);
  return `${base}-text-${randomUUID().slice(0, 8)}`;
}

function buildTaskIntercomSessionId(sessionId: string, taskId: string): string {
  const base = safeRemotePathPart(normalizeString(sessionId) || DEFAULT_SESSION_ID, DEFAULT_SESSION_ID);
  return `${base}-task-${safeRemotePathPart(taskId, 'task')}`;
}

function buildIntercomSessionKey(route: IntercomRoute, sessionId: string): string {
  const agent = safeRemotePathPart(route.agent || 'main', 'main');
  const session = safeRemotePathPart(normalizeString(sessionId) || DEFAULT_SESSION_ID, DEFAULT_SESSION_ID);
  return `agent:${agent}:${session}`;
}

type IntercomGatewayStatus = 'running' | 'completed' | 'timeout_waiting_for_history';

function normalizeIntercomGatewayStatus(value: unknown): IntercomGatewayStatus | null {
  if (value === 'running' || value === 'completed' || value === 'timeout_waiting_for_history') {
    return value;
  }
  return null;
}

function readIntercomGatewayMeta(output: { stdout: string; stderr: string }): {
  status: IntercomGatewayStatus | null;
  beforeCount: number | null;
  sessionKey: string | null;
} {
  const parsed = parseIntercomJson(output.stdout) ?? parseIntercomJson(output.stderr);
  if (!isRecord(parsed) || !isRecord(parsed.meta)) {
    return { status: null, beforeCount: null, sessionKey: null };
  }
  const beforeCount = typeof parsed.meta.beforeCount === 'number' && Number.isFinite(parsed.meta.beforeCount)
    ? Math.max(0, Math.floor(parsed.meta.beforeCount))
    : null;
  return {
    status: normalizeIntercomGatewayStatus(parsed.meta.status),
    beforeCount,
    sessionKey: normalizeString(parsed.meta.sessionKey) || null,
  };
}

function buildIntercomSendPollState(
  sessionId: string,
  commandResult: { stdout: string; stderr: string },
): Pick<IntercomSendResult, 'pending' | 'poll'> {
  const meta = readIntercomGatewayMeta(commandResult);
  const status = meta.status;
  if (!status || status === 'completed' || meta.beforeCount === null) {
    return {};
  }
  return {
    pending: true,
    poll: {
      sessionId,
      beforeCount: meta.beforeCount,
      status,
    },
  };
}

async function resolveIntercomTarget(target: string): Promise<{
  snapshot: IntercomSnapshot;
  target: string;
  route: IntercomRoute;
}> {
  const routeId = normalizeRouteId(target);
  const snapshot = await getIntercomSnapshot();
  const route = snapshot.routes.find((entry) => entry.id === routeId);
  if (!route) {
    throw new Error(`Intercom target not found: ${routeId}`);
  }
  if (!route.enabled) {
    throw new Error(`Intercom target is disabled: ${routeId}`);
  }
  return { snapshot, target: routeId, route };
}

async function runIntercomRouteMessage(params: {
  route: IntercomRoute;
  message: string;
  sessionId: string;
  allowCliFallback?: boolean;
}): Promise<{
  route: IntercomRoute;
  sessionId: string;
  invocation: { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv };
  commandResult: { exitCode: number | null; stdout: string; stderr: string; durationMs: number };
}> {
  const sshPassword = params.route.transport === 'ssh' ? await getIntercomSshPassword(params.route.id) : null;
  const runMessageOnce = async (
    message: string,
    route: IntercomRoute,
    options: { windowsAuto?: boolean; allowCliFallback?: boolean } = {
      allowCliFallback: params.allowCliFallback,
    },
    sessionId = params.sessionId,
  ) => {
    const runForMessage = async (targetRoute: IntercomRoute) => {
      const remoteCommand = options.windowsAuto
        ? buildWindowsAutoOpenClawCommand(targetRoute, message, sessionId, {
            allowCliFallback: params.allowCliFallback,
          })
        : buildRemoteCommand(targetRoute, message, sessionId, {
            allowCliFallback: params.allowCliFallback,
          });
      const invocation = targetRoute.transport === 'ssh' && sshPassword
        ? {
            command: 'ssh2',
            args: [
              `${resolveSshHostAndUsername(targetRoute).username || userInfo().username}@${resolveSshHostAndUsername(targetRoute).host}`,
              remoteCommand,
            ],
          }
          : targetRoute.transport === 'ssh'
          ? buildSshCommand(targetRoute, message, sessionId, {
              ...options,
              allowCliFallback: params.allowCliFallback,
            })
          : buildLocalCommand(targetRoute, message, sessionId);
      const commandResult = targetRoute.transport === 'ssh' && sshPassword
        ? await runSsh2Command(targetRoute, sshPassword, message, sessionId, {
            ...options,
            allowCliFallback: params.allowCliFallback,
          })
        : await runIntercomCommand(invocation.command, invocation.args, {
            cwd: 'cwd' in invocation ? invocation.cwd : undefined,
            env: 'env' in invocation ? invocation.env : process.env,
          });
      return { route: targetRoute, sessionId, invocation, commandResult };
    };

    try {
      return await runForMessage(route);
    } catch (error) {
      if (!options.windowsAuto && shouldRetryWithAutoRemoteDiscovery(route, error)) {
        logger.warn('Retrying intercom command with Windows KTClaw/OpenClaw auto-discovery', {
          target: params.route.id,
          host: params.route.host,
          agent: params.route.agent,
        });
        return runMessageOnce(message, route, {
          windowsAuto: true,
          allowCliFallback: params.allowCliFallback,
        }, sessionId);
      }
      if (!getIntercomErrorText(error).includes('KTClaw executable not found at /usr/ktclaw')) {
        throw error;
      }
      logger.warn('Retrying intercom command with bundled Linux KTClaw OpenClaw entry', {
        target: params.route.id,
        host: params.route.host,
        agent: params.route.agent,
      });
      return runMessageOnce(message, withBundledLinuxOpenClawCommand(route), {
        ...options,
        allowCliFallback: params.allowCliFallback,
      }, sessionId);
    }
  };

  try {
    const firstResult = await runMessageOnce(params.message, params.route);
    if (isIntercomResetCommand(params.message) || !isIntercomTextOnlyImageSchemaFailure(firstResult.commandResult)) {
      return firstResult;
    }

    const cleanSessionId = buildCleanIntercomSessionId(params.sessionId);
    logger.warn('Intercom session history contains image_url content for a text-only model; retrying with a clean session', {
      target: params.route.id,
      host: params.route.host,
      agent: params.route.agent,
      sessionId: cleanSessionId,
    });
    return runMessageOnce(params.message, firstResult.route, {}, cleanSessionId);
  } catch (error) {
    if (isIntercomResetCommand(params.message) || !isIntercomTextOnlyImageSchemaFailure(error)) {
      throw error;
    }

    const cleanSessionId = buildCleanIntercomSessionId(params.sessionId);
    logger.warn('Intercom command failed because session history contains image_url content; retrying with a clean session', {
      target: params.route.id,
      host: params.route.host,
      agent: params.route.agent,
      sessionId: cleanSessionId,
    });
    return runMessageOnce(params.message, params.route, {}, cleanSessionId);
  }
}

function buildSshCommand(
  route: IntercomRoute,
  message: string,
  sessionId: string,
  options: { windowsAuto?: boolean; allowCliFallback?: boolean } = {},
) {
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
      options.windowsAuto
        ? buildWindowsAutoOpenClawCommand(route, message, sessionId, {
            allowCliFallback: options.allowCliFallback,
          })
        : buildRemoteCommand(route, message, sessionId, {
            allowCliFallback: options.allowCliFallback,
          }),
    ],
    cwd: undefined,
    env: process.env,
  };
}

function buildRawSshCommand(route: IntercomRoute, remoteCommand: string) {
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
      remoteCommand,
    ],
    cwd: undefined,
    env: process.env,
  };
}

async function createSsh2Client(): Promise<Ssh2Client> {
  try {
    const ssh2 = await import('ssh2');
    return new ssh2.Client();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`KTClaw SSH runtime dependency is unavailable. Reinstall or rebuild KTClaw with ssh2 bundled. Original error: ${message}`, {
      cause: error,
    });
  }
}

async function runSsh2RawCommand(
  route: IntercomRoute,
  password: string,
  remoteCommand: string,
  timeoutMs = INTERCOM_COMMAND_TIMEOUT_MS,
) {
  const startedAt = Date.now();
  const client = await createSsh2Client();
  const resolved = resolveSshHostAndUsername(route);
  const username = resolved.username || userInfo().username;
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
      const message = `Intercom SSH command timed out after ${Math.round(timeoutMs / 1000)}s`;
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
    }, timeoutMs);

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

async function runSsh2Command(
  route: IntercomRoute,
  password: string,
  message: string,
  sessionId: string,
  options: { windowsAuto?: boolean; allowCliFallback?: boolean } = {},
) {
  const remoteCommand = options.windowsAuto
    ? buildWindowsAutoOpenClawCommand(route, message, sessionId, {
        allowCliFallback: options.allowCliFallback,
      })
    : buildRemoteCommand(route, message, sessionId, {
        allowCliFallback: options.allowCliFallback,
      });
  return runSsh2RawCommand(route, password, remoteCommand);
}

function getIntercomErrorExitCode(error: unknown): number | null {
  if (error && typeof error === 'object' && typeof (error as { exitCode?: unknown }).exitCode === 'number') {
    return (error as { exitCode: number }).exitCode;
  }
  return null;
}

function isDesktopCameraUnavailable(error: unknown): boolean {
  const normalized = getIntercomErrorText(error).toLowerCase();
  return getIntercomErrorExitCode(error) === 86
    || normalized.includes('ktclaw desktop camera ui did not respond')
    || normalized.includes('ktclaw desktop camera ui did not accept')
    || normalized.includes('ktclaw desktop camera ui did not return a photo')
    || normalized.includes('desktop camera request was cancelled')
    || normalized.includes('desktop camera request was canceled');
}

function isDesktopCameraUnavailableResult(commandResult: { stdout: string; stderr: string }): boolean {
  const result = normalizeIntercomRemoteTaskCommandResult(commandResult);
  if (result.success) {
    return false;
  }
  if (result.error || result.logs || result.summary) {
    return true;
  }
  return isDesktopCameraUnavailable([
    result.summary,
    result.logs,
    result.error,
    commandResult.stdout,
    commandResult.stderr,
  ].filter(Boolean).join('\n'));
}

function isDesktopScreenshotUnavailable(error: unknown): boolean {
  const normalized = getIntercomErrorText(error).toLowerCase();
  return getIntercomErrorExitCode(error) === 86
    || normalized.includes('ktclaw desktop screenshot service did not respond')
    || normalized.includes('ktclaw desktop screenshot service did not accept');
}

function isDesktopScreenshotUnavailableResult(commandResult: { stdout: string; stderr: string }): boolean {
  const result = normalizeIntercomRemoteTaskCommandResult(commandResult);
  if (result.success) {
    return false;
  }
  if (result.error || result.logs || result.summary) {
    return true;
  }
  return isDesktopScreenshotUnavailable([
    result.summary,
    result.logs,
    result.error,
    commandResult.stdout,
    commandResult.stderr,
  ].filter(Boolean).join('\n'));
}

async function runRawIntercomRemoteCommand(
  route: IntercomRoute,
  remoteCommand: string,
  timeoutMs = INTERCOM_COMMAND_TIMEOUT_MS,
): Promise<{
  invocation: { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv };
  commandResult: { exitCode: number | null; stdout: string; stderr: string; durationMs: number };
}> {
  const sshPassword = route.transport === 'ssh' ? await getIntercomSshPassword(route.id) : null;
  if (route.transport === 'ssh' && sshPassword) {
    const resolved = resolveSshHostAndUsername(route);
    const invocation = {
      command: 'ssh2',
      args: [`${resolved.username || userInfo().username}@${resolved.host}`, remoteCommand],
    };
    const commandResult = await runSsh2RawCommand(route, sshPassword, remoteCommand, timeoutMs);
    return { invocation, commandResult };
  }
  if (route.transport === 'ssh') {
    const invocation = buildRawSshCommand(route, remoteCommand);
    const commandResult = await runIntercomCommand(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      timeoutMs,
    });
    return { invocation, commandResult };
  }
  throw new Error('Direct remote capture tasks require an SSH intercom route');
}

async function runDirectIntercomCaptureTask(route: IntercomRoute, task: IntercomRemoteTaskRequest): Promise<{
  invocation: { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv };
  commandResult: { exitCode: number | null; stdout: string; stderr: string; durationMs: number };
} | null> {
  if (route.transport !== 'ssh') {
    return null;
  }
  const action = normalizeDirectTaskAction(task.action);
  if (!action) {
    if (!shouldUseDirectInboxFileInspection(task)) {
      return null;
    }
    try {
      return await runRawIntercomRemoteCommand(route, buildPosixInboxFileInspectionCommand(task), INTERCOM_DIRECT_FILE_INSPECT_TIMEOUT_MS);
    } catch (error) {
      if (shouldRetryWithAutoRemoteDiscovery(route, error)) {
        return runRawIntercomRemoteCommand(route, buildWindowsInboxFileInspectionCommand(task), INTERCOM_DIRECT_FILE_INSPECT_TIMEOUT_MS);
      }
      throw error;
    }
  }

  if (action === 'screenshot') {
    try {
      const desktopResult = await runRawIntercomRemoteCommand(route, buildPosixDesktopScreenshotCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
      if (!isDesktopScreenshotUnavailableResult(desktopResult.commandResult)) {
        return desktopResult;
      }
    } catch (desktopError) {
      if (shouldRetryWithAutoRemoteDiscovery(route, desktopError)) {
        try {
          const windowsDesktopResult = await runRawIntercomRemoteCommand(route, buildWindowsDesktopScreenshotCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
          if (!isDesktopScreenshotUnavailableResult(windowsDesktopResult.commandResult)) {
            return windowsDesktopResult;
          }
          return runRawIntercomRemoteCommand(route, buildWindowsScreenshotCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
        } catch (windowsDesktopError) {
          if (!isDesktopScreenshotUnavailable(windowsDesktopError)) {
            throw windowsDesktopError;
          }
          return runRawIntercomRemoteCommand(route, buildWindowsScreenshotCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
        }
      }
      if (!isDesktopScreenshotUnavailable(desktopError)) {
        throw desktopError;
      }
    }

    try {
      return await runRawIntercomRemoteCommand(route, buildPosixScreenshotCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
    } catch (error) {
      if (shouldRetryWithAutoRemoteDiscovery(route, error)) {
        return runRawIntercomRemoteCommand(route, buildWindowsScreenshotCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
      }
      throw error;
    }
  }

  try {
    const desktopResult = await runRawIntercomRemoteCommand(route, buildPosixDesktopCameraCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
    if (!isDesktopCameraUnavailableResult(desktopResult.commandResult)) {
      return desktopResult;
    }
  } catch (desktopError) {
    if (shouldRetryWithAutoRemoteDiscovery(route, desktopError)) {
      try {
        const windowsDesktopResult = await runRawIntercomRemoteCommand(route, buildWindowsDesktopCameraCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
        if (!isDesktopCameraUnavailableResult(windowsDesktopResult.commandResult)) {
          return windowsDesktopResult;
        }
        return runRawIntercomRemoteCommand(route, buildWindowsCameraToolCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
      } catch (windowsDesktopError) {
        if (!isDesktopCameraUnavailable(windowsDesktopError)) {
          throw windowsDesktopError;
        }
        return runRawIntercomRemoteCommand(route, buildWindowsCameraToolCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
      }
    }
    if (!isDesktopCameraUnavailable(desktopError)) {
      throw desktopError;
    }
  }

  try {
    return await runRawIntercomRemoteCommand(route, buildPosixCameraToolCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
  } catch (toolError) {
    if (shouldRetryWithAutoRemoteDiscovery(route, toolError)) {
      return runRawIntercomRemoteCommand(route, buildWindowsCameraToolCommand(task), INTERCOM_DIRECT_CAPTURE_TIMEOUT_MS);
    }
    throw toolError;
  }
}

function buildSsh2ConnectConfig(route: IntercomRoute, password: string): ConnectConfig {
  const resolved = resolveSshHostAndUsername(route);
  return {
    host: resolved.host,
    port: route.sshPort ?? 22,
    username: resolved.username || userInfo().username,
    password,
    readyTimeout: SSH_CONNECT_TIMEOUT_SECONDS * 1000,
    timeout: SSH_CONNECT_TIMEOUT_SECONDS * 1000,
    tryKeyboard: true,
  };
}

async function withIntercomSftp<T>(
  route: IntercomRoute,
  callback: (sftp: SFTPWrapper) => Promise<T>,
): Promise<T> {
  if (route.transport !== 'ssh') {
    throw new Error('SFTP transfers require an SSH intercom route');
  }
  const password = await getIntercomSshPassword(route.id);
  if (!password) {
    throw new Error('SFTP requires a saved SSH password for this route');
  }

  const client = await createSsh2Client();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      client.end();
      fn();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`Intercom SFTP connection timed out after ${SSH_CONNECT_TIMEOUT_SECONDS}s`)));
    }, SSH_CONNECT_TIMEOUT_SECONDS * 1000);

    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, done) => {
      done(prompts.map(() => password));
    });
    client.on('error', (error) => {
      finish(() => reject(error));
    });
    client.on('ready', () => {
      client.sftp((error, sftp) => {
        if (error) {
          finish(() => reject(error));
          return;
        }
        callback(sftp)
          .then((result) => finish(() => resolve(result)))
          .catch((callbackError) => finish(() => reject(callbackError)));
      });
    });
    client.connect(buildSsh2ConnectConfig(route, password));
  });
}

function sftpMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(toSftpPath(remotePath), (error) => {
      if (!error || (error as NodeJS.ErrnoException).code === 4) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

async function ensureSftpDir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const normalized = normalizeRemotePath(remotePath).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '/') {
    return;
  }
  const withoutHome = normalized.startsWith('~/') ? normalized.slice(2) : normalized;
  const absolute = normalized.startsWith('/') && !normalized.startsWith('~/');
  const parts = withoutHome.split('/').filter(Boolean);
  let current = absolute ? '/' : '';
  for (const part of parts) {
    current = current && current !== '/' ? `${current}/${part}` : absolute ? `/${part}` : part;
    await sftpMkdir(sftp, current);
  }
}

function sftpFastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, toSftpPath(remotePath), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sftpFastGet(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(toSftpPath(remotePath), localPath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function buildSftpHostArg(route: IntercomRoute): string {
  const resolved = resolveSshHostAndUsername(route);
  const username = resolved.username || userInfo().username;
  return `${username}@${resolved.host}`;
}

function quoteSftpBatchPath(value: string): string {
  return `"${value.replace(/\\/g, '/').replaceAll('"', '\\"')}"`;
}

function buildSftpDirCreationBatch(remoteDir: string): string[] {
  const normalized = normalizeRemotePath(remoteDir).replace(/\/+$/, '');
  const withoutHome = toSftpPath(normalized);
  const parts = withoutHome.split('/').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    lines.push(`-mkdir ${quoteSftpBatchPath(current)}`);
  }
  return lines;
}

function runSftpBatch(route: IntercomRoute, batch: string): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  const startedAt = Date.now();
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    '-b',
    '-',
    ...(route.sshPort ? ['-P', String(route.sshPort)] : []),
    buildSftpHostArg(route),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('sftp', args, {
      env: process.env,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let completed = false;
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
    const buildResult = () => ({
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
    });
    const timeout = setTimeout(() => {
      const result = buildResult();
      const message = `Intercom SFTP command timed out after ${SSH_CONNECT_TIMEOUT_SECONDS}s`;
      finish(() => reject(new Error(`${message}. ${result.stderr || result.stdout}`.trim())));
    }, SSH_CONNECT_TIMEOUT_SECONDS * 1000);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish(() => reject(new Error(`Intercom SFTP command failed to start: ${error.message}`)));
    });
    child.on('close', (code) => {
      const result = buildResult();
      if (code && code !== 0) {
        const details = result.stderr || result.stdout || `exit code ${code}`;
        finish(() => reject(new Error(`Intercom SFTP command failed: ${details}`)));
        return;
      }
      finish(() => resolve(result));
    });
    child.stdin?.end(`${batch.replace(/\s+$/, '')}\n`);
  });
}

function runIntercomCommand(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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
      const timeoutMs = options.timeoutMs ?? INTERCOM_COMMAND_TIMEOUT_MS;
      const message = `Intercom command timed out after ${Math.round(timeoutMs / 1000)}s`;
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
    }, options.timeoutMs ?? INTERCOM_COMMAND_TIMEOUT_MS);

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

function ensureIntercomConfig(config: StoredIntercomConfig): StoredIntercomConfig {
  const current = getStoredIntercomConfig(config);
  const next: StoredIntercomConfig = {
    ...current,
    defaultSessionId: normalizeString(current.defaultSessionId) || DEFAULT_SESSION_ID,
    localHost: normalizeString(current.localHost) || hostname() || 'local',
    agents: current.agents && typeof current.agents === 'object' && !Array.isArray(current.agents)
      ? { ...current.agents }
      : {},
  };
  return next;
}

export async function getIntercomSnapshot(): Promise<IntercomSnapshot> {
  const [rawConfig, agentsSnapshot] = await Promise.all([
    migrateLegacyIntercomConfig(),
    listAgentsSnapshot(),
  ]);
  const config = ensureIntercomConfig(rawConfig);
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

export async function getIntercomHostReadiness(): Promise<IntercomHostReadiness> {
  const snapshot = await getIntercomSnapshot();
  const selfConfig = snapshot.selfConfig;
  const platform = process.platform;
  const sshListening = await isTcpPortListening(selfConfig.sshPort || DEFAULT_SSH_PORT);
  const canPrepare = Boolean(await buildPrepareInvocation(platform));
  const prepareCommandPreview = buildPrepareCommandPreview(platform);
  const checks: IntercomHostReadinessCheck[] = [
    createReadinessCheck(
      'lan-host',
      isShareableHost(selfConfig.host) ? 'ok' : 'missing',
      'Shareable host/IP',
      isShareableHost(selfConfig.host)
        ? `Other machines can use ${selfConfig.host}.`
        : 'No LAN/VPN address was detected. Connect to a network or use a tunnel before sharing this machine.',
    ),
    createReadinessCheck(
      'ssh-user',
      selfConfig.sshUser ? 'ok' : 'missing',
      'SSH user',
      selfConfig.sshUser
        ? `Other machines should log in as ${selfConfig.sshUser}.`
        : 'KTClaw could not detect the local OS user. Enter the SSH user manually on the other machine.',
    ),
    createReadinessCheck(
      'agent',
      selfConfig.agentId ? 'ok' : 'missing',
      'Local agent',
      selfConfig.agentId
        ? `Default target agent is ${selfConfig.agentId}.`
        : 'No local agent was detected. Create or enable an agent before sharing this machine.',
    ),
    createReadinessCheck(
      'ssh-listener',
      sshListening ? 'ok' : 'missing',
      'SSH listener',
      sshListening
        ? `SSH is accepting local connections on port ${selfConfig.sshPort || DEFAULT_SSH_PORT}.`
        : `No SSH listener was detected on port ${selfConfig.sshPort || DEFAULT_SSH_PORT}. Use Prepare this machine to install/start OpenSSH.`,
    ),
    createReadinessCheck(
      'firewall',
      sshListening ? 'warning' : 'unknown',
      'Firewall',
      sshListening
        ? 'Local SSH is running. If another machine still cannot connect, allow SSH through the system firewall.'
        : 'Firewall status can be verified after SSH is installed and running.',
    ),
    createReadinessCheck(
      'remote-command',
      selfConfig.remoteCommand ? 'ok' : 'missing',
      'KTClaw command',
      selfConfig.remoteCommand
        ? 'KTClaw will provide the command that the other machine should use automatically.'
        : 'No remote KTClaw command was detected.',
    ),
  ];
  const blockingChecks = checks.filter((check) => check.status === 'missing');
  return {
    ready: blockingChecks.length === 0,
    accessEnabled: sshListening,
    platform,
    canPrepare,
    needsAdmin: canPrepare,
    host: selfConfig.host,
    sshUser: selfConfig.sshUser,
    sshPort: selfConfig.sshPort || DEFAULT_SSH_PORT,
    agentId: selfConfig.agentId,
    sessionId: selfConfig.sessionId,
    remoteCommand: selfConfig.remoteCommand,
    remoteGatewayPort: selfConfig.remoteGatewayPort,
    checks,
    prepareCommandPreview,
  };
}

export async function prepareIntercomHost(): Promise<IntercomHostPrepareResult> {
  const invocation = await buildHostAccessInvocation(process.platform, true);
  if (!invocation) {
    const status = await getIntercomHostReadiness();
    return {
      success: false,
      started: false,
      stdout: '',
      stderr: '',
      error: `Automatic host preparation is not supported on ${process.platform}.`,
      status,
    };
  }

  const result = await runPrepareInvocation(invocation);
  return {
    ...result,
    started: true,
    status: await getIntercomHostReadiness(),
  };
}

export async function setIntercomHostAccess(enabled: boolean): Promise<IntercomHostPrepareResult> {
  if (enabled) {
    return prepareIntercomHost();
  }

  const invocation = await buildHostAccessInvocation(process.platform, false);
  if (!invocation) {
    const status = await getIntercomHostReadiness();
    return {
      success: false,
      started: false,
      stdout: '',
      stderr: '',
      error: `Automatic host access changes are not supported on ${process.platform}.`,
      status,
    };
  }

  const result = await runPrepareInvocation(invocation);
  return {
    ...result,
    started: true,
    status: await getIntercomHostReadiness(),
  };
}

export async function upsertIntercomRoute(input: IntercomRouteInput): Promise<IntercomSnapshot> {
  await withConfigLock(async () => {
    const config = ensureIntercomConfig(await migrateLegacyIntercomConfig());
    const route = normalizeRouteForStorage(input, config);
    await updateIntercomSshPassword(route.id, input);
    config.agents = {
      ...(config.agents ?? {}),
      [route.id]: toStoredRoute(route),
    };
    await writeStandaloneIntercomConfig(config);
  });
  return getIntercomSnapshot();
}

export async function deleteIntercomRoute(routeId: string): Promise<IntercomSnapshot> {
  await withConfigLock(async () => {
    const config = ensureIntercomConfig(await migrateLegacyIntercomConfig());
    const id = normalizeRouteId(routeId);
    delete config.agents?.[id];
    await deleteProviderSecret(getIntercomSshSecretId(id));
    await writeStandaloneIntercomConfig(config);
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

  const { snapshot, route } = await resolveIntercomTarget(target);
  if (route.transport === 'nats') {
    throw new Error('NATS intercom transport is not implemented yet');
  }

  const sessionId = normalizeString(input.sessionId) || route.sessionId || snapshot.defaultSessionId;
  const finalMessage = buildCallerMessage(sender, message);
  const { invocation, commandResult, sessionId: actualSessionId } = await runIntercomRouteMessage({
    route,
    message: finalMessage,
    sessionId,
    allowCliFallback: false,
  });
  const pollState = buildIntercomSendPollState(actualSessionId, commandResult);

  return {
    success: true,
    queued: false,
    target,
    sender,
    transport: route.transport,
    host: route.host,
    agent: route.agent,
    sessionId: actualSessionId,
    command: invocation.command,
    args: invocation.args,
    exitCode: commandResult.exitCode,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    durationMs: commandResult.durationMs,
    ...pollState,
  };
}

export async function pollIntercomMessage(input: IntercomPollInput): Promise<IntercomSendResult> {
  const target = normalizeRouteId(input.target);
  const { snapshot, route } = await resolveIntercomTarget(target);
  if (route.transport === 'nats') {
    throw new Error('NATS intercom transport is not implemented yet');
  }
  if (route.transport !== 'ssh') {
    throw new Error('Remote Gateway polling requires an SSH intercom route');
  }

  const sessionId = normalizeString(input.sessionId) || route.sessionId || snapshot.defaultSessionId;
  const beforeCount = typeof input.beforeCount === 'number' && Number.isFinite(input.beforeCount)
    ? Math.max(0, Math.floor(input.beforeCount))
    : 0;
  const sshPassword = await getIntercomSshPassword(route.id);
  const runPollOnce = async (options: { windowsAuto?: boolean } = {}) => {
    const remoteCommand = options.windowsAuto
      ? buildWindowsRemoteGatewayHistoryCommand(route, sessionId, beforeCount)
      : buildPosixRemoteGatewayHistoryCommand(route, sessionId, beforeCount);
    const invocation = sshPassword
      ? {
          command: 'ssh2',
          args: [
            `${resolveSshHostAndUsername(route).username || userInfo().username}@${resolveSshHostAndUsername(route).host}`,
            remoteCommand,
          ],
        }
      : buildRawSshCommand(route, remoteCommand);
    const commandResult = sshPassword
      ? await runSsh2RawCommand(route, sshPassword, remoteCommand, 20_000)
      : await runIntercomCommand(invocation.command, invocation.args, {
          cwd: 'cwd' in invocation ? invocation.cwd : undefined,
          env: 'env' in invocation ? invocation.env : process.env,
          timeoutMs: 20_000,
        });
    return { invocation, commandResult };
  };

  let pollResult: Awaited<ReturnType<typeof runPollOnce>>;
  try {
    pollResult = await runPollOnce();
  } catch (error) {
    if (!shouldRetryWithAutoRemoteDiscovery(route, error)) {
      throw error;
    }
    pollResult = await runPollOnce({ windowsAuto: true });
  }
  const pollState = buildIntercomSendPollState(sessionId, pollResult.commandResult);

  return {
    success: true,
    queued: false,
    target,
    sender: 'ktclaw',
    transport: route.transport,
    host: route.host,
    agent: route.agent,
    sessionId,
    command: pollResult.invocation.command,
    args: pollResult.invocation.args,
    exitCode: pollResult.commandResult.exitCode,
    stdout: pollResult.commandResult.stdout,
    stderr: pollResult.commandResult.stderr,
    durationMs: pollResult.commandResult.durationMs,
    ...pollState,
  };
}

export async function sendIntercomTask(input: IntercomRemoteTaskSendInput): Promise<IntercomRemoteTaskSendResult> {
  const target = normalizeRouteId(input.target);
  const sender = normalizeString(input.sender) || 'ktclaw';
  const { snapshot, route } = await resolveIntercomTarget(target);
  if (route.transport === 'nats') {
    throw new Error('NATS intercom transport is not implemented yet');
  }

  const task = buildIntercomRemoteTaskRequest(input);
  const baseSessionId = normalizeString(input.sessionId) || route.sessionId || snapshot.defaultSessionId;
  const sessionId = buildTaskIntercomSessionId(baseSessionId, task.taskId);
  const directResult = await runDirectIntercomCaptureTask(route, task);
  if (directResult) {
    return {
      success: true,
      queued: false,
      taskId: task.taskId,
      task,
      result: normalizeIntercomRemoteTaskCommandResult(directResult.commandResult),
      target,
      sender,
      transport: route.transport,
      host: route.host,
      agent: route.agent,
      sessionId,
      command: directResult.invocation.command,
      args: directResult.invocation.args,
      exitCode: directResult.commandResult.exitCode,
      stdout: directResult.commandResult.stdout,
      stderr: directResult.commandResult.stderr,
      durationMs: directResult.commandResult.durationMs,
    };
  }
  const finalMessage = buildIntercomRemoteTaskMessage(sender, task);
  const { invocation, commandResult, sessionId: actualSessionId } = await runIntercomRouteMessage({
    route,
    message: finalMessage,
    sessionId,
    allowCliFallback: true,
  });

  return {
    success: true,
    queued: false,
    taskId: task.taskId,
    task,
    result: normalizeIntercomRemoteTaskCommandResult(commandResult),
    target,
    sender,
    transport: route.transport,
    host: route.host,
    agent: route.agent,
    sessionId: actualSessionId,
    command: invocation.command,
    args: invocation.args,
    exitCode: commandResult.exitCode,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    durationMs: commandResult.durationMs,
  };
}

export async function uploadIntercomFiles(input: IntercomUploadFilesInput): Promise<{
  success: true;
  taskId: string;
  target: string;
  transfers: IntercomTransferRecord[];
}> {
  const target = normalizeRouteId(input.target);
  const sender = normalizeString(input.sender) || 'ktclaw';
  const taskId = normalizeTaskId(input.taskId);
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length === 0) {
    throw new Error('files are required');
  }
  const { route } = await resolveIntercomTarget(target);
  if (route.transport === 'nats') {
    throw new Error('NATS intercom transport is not implemented yet');
  }
  if (route.transport !== 'ssh') {
    throw new Error('SFTP transfers require an SSH intercom route');
  }

  const remoteDir = remoteInboxDir(sender, taskId);
  const password = await getIntercomSshPassword(route.id);
  if (!password) {
    const records: IntercomTransferRecord[] = [];
    const batch = buildSftpDirCreationBatch(remoteDir);
    for (const file of files) {
      const localPath = normalizeString(file.localPath);
      if (!localPath) {
        throw new Error('localPath is required for every upload file');
      }
      const startedAt = Date.now();
      const fileName = safeRemotePathPart(normalizeString(file.fileName) || basename(localPath), 'file');
      const remotePath = pathPosix.join(remoteDir, fileName);
      const localStat = await stat(localPath);
      batch.push(`put ${quoteSftpBatchPath(localPath)} ${quoteSftpBatchPath(toSftpPath(remotePath))}`);
      records.push({
        id: randomUUID(),
        routeId: route.id,
        taskId,
        direction: 'upload',
        status: 'success',
        fileName,
        localPath,
        remotePath,
        mimeType: normalizeString(file.mimeType) || getMimeType(fileName),
        size: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : localStat.size,
        durationMs: Date.now() - startedAt,
        error: null,
      });
    }
    const startedAt = Date.now();
    await runSftpBatch(route, batch.join('\n'));
    return {
      success: true,
      taskId,
      target,
      transfers: records.map((record) => ({
        ...record,
        durationMs: Math.max(record.durationMs, Date.now() - startedAt),
      })),
    };
  }

  const transfers = await withIntercomSftp(route, async (sftp) => {
    await ensureSftpDir(sftp, remoteDir);
    const records: IntercomTransferRecord[] = [];
    for (const file of files) {
      const localPath = normalizeString(file.localPath);
      if (!localPath) {
        throw new Error('localPath is required for every upload file');
      }
      const startedAt = Date.now();
      const fileName = safeRemotePathPart(normalizeString(file.fileName) || basename(localPath), 'file');
      const remotePath = pathPosix.join(remoteDir, fileName);
      const localStat = await stat(localPath);
      await sftpFastPut(sftp, localPath, remotePath);
      records.push({
        id: randomUUID(),
        routeId: route.id,
        taskId,
        direction: 'upload',
        status: 'success',
        fileName,
        localPath,
        remotePath,
        mimeType: normalizeString(file.mimeType) || getMimeType(fileName),
        size: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : localStat.size,
        durationMs: Date.now() - startedAt,
        error: null,
      });
    }
    return records;
  });

  return {
    success: true,
    taskId,
    target,
    transfers,
  };
}

function isImageArtifactDownload(artifact: IntercomDownloadArtifactInput, fileName: string): boolean {
  const mimeType = normalizeString(artifact.mimeType);
  return artifact.type === 'image'
    || mimeType.startsWith('image/')
    || inferArtifactType(fileName, mimeType) === 'image';
}

function assertDownloadedArtifactReadable(input: {
  artifact: IntercomDownloadArtifactInput;
  fileName: string;
  localPath: string;
  size: number;
}): void {
  if (isImageArtifactDownload(input.artifact, input.fileName) && input.size <= 0) {
    throw new Error(`Downloaded remote image artifact is empty: ${input.fileName} (${input.localPath})`);
  }
}

export async function downloadIntercomArtifacts(input: IntercomDownloadArtifactsInput): Promise<{
  success: true;
  taskId: string;
  target: string;
  transfers: IntercomTransferRecord[];
}> {
  const target = normalizeRouteId(input.target);
  const taskId = normalizeTaskId(input.taskId);
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  if (artifacts.length === 0) {
    throw new Error('artifacts are required');
  }
  const { route } = await resolveIntercomTarget(target);
  if (route.transport === 'nats') {
    throw new Error('NATS intercom transport is not implemented yet');
  }
  if (route.transport !== 'ssh') {
    throw new Error('SFTP transfers require an SSH intercom route');
  }

  const localDir = join(INTERCOM_ARTIFACT_CACHE_DIR, safeRemotePathPart(route.id, 'route'), safeRemotePathPart(taskId, 'task'));
  await mkdir(localDir, { recursive: true });
  const password = await getIntercomSshPassword(route.id);
  if (!password) {
    const records: IntercomTransferRecord[] = [];
    const batch: string[] = [];
    for (const artifact of artifacts) {
      const remotePath = normalizeRemotePath(normalizeString(artifact.path));
      if (!remotePath) {
        throw new Error('artifact path is required for every download');
      }
      const startedAt = Date.now();
      const fileName = safeRemotePathPart(normalizeString(artifact.name) || basename(remotePath), `artifact-${records.length + 1}`);
      const localPath = join(localDir, fileName);
      await mkdir(dirname(localPath), { recursive: true });
      batch.push(`get ${quoteSftpBatchPath(toSftpPath(remotePath))} ${quoteSftpBatchPath(localPath)}`);
      records.push({
        id: randomUUID(),
        routeId: route.id,
        taskId,
        direction: 'download',
        status: 'success',
        fileName,
        localPath,
        remotePath,
        mimeType: normalizeString(artifact.mimeType) || getMimeType(fileName),
        size: typeof artifact.size === 'number' && Number.isFinite(artifact.size) ? artifact.size : 0,
        durationMs: Date.now() - startedAt,
        error: null,
      });
    }
    const startedAt = Date.now();
    await runSftpBatch(route, batch.join('\n'));
    const transfers = await Promise.all(records.map(async (record, index) => {
      const localStat = await stat(record.localPath || '');
      assertDownloadedArtifactReadable({
        artifact: artifacts[index] ?? { path: '' },
        fileName: record.fileName,
        localPath: record.localPath || '',
        size: localStat.size,
      });
      return {
        ...record,
        size: record.size || localStat.size,
        durationMs: Math.max(record.durationMs, Date.now() - startedAt),
      };
    }));
    return {
      success: true,
      taskId,
      target,
      transfers,
    };
  }

  const transfers = await withIntercomSftp(route, async (sftp) => {
    const records: IntercomTransferRecord[] = [];
    for (const artifact of artifacts) {
      const remotePath = normalizeRemotePath(normalizeString(artifact.path));
      if (!remotePath) {
        throw new Error('artifact path is required for every download');
      }
      const startedAt = Date.now();
      const fileName = safeRemotePathPart(normalizeString(artifact.name) || basename(remotePath), `artifact-${records.length + 1}`);
      const localPath = join(localDir, fileName);
      await mkdir(dirname(localPath), { recursive: true });
      await ensureSftpDir(sftp, parentRemoteDir(remotePath));
      await sftpFastGet(sftp, remotePath, localPath);
      const localStat = await stat(localPath);
      assertDownloadedArtifactReadable({
        artifact,
        fileName,
        localPath,
        size: localStat.size,
      });
      records.push({
        id: randomUUID(),
        routeId: route.id,
        taskId,
        direction: 'download',
        status: 'success',
        fileName,
        localPath,
        remotePath,
        mimeType: normalizeString(artifact.mimeType) || getMimeType(fileName),
        size: typeof artifact.size === 'number' && Number.isFinite(artifact.size) ? artifact.size : localStat.size,
        durationMs: Date.now() - startedAt,
        error: null,
      });
    }
    return records;
  });

  return {
    success: true,
    taskId,
    target,
    transfers,
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
