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
  const commandParts = splitPosixCommand(resolveRemoteCommandPrefix(route));
  const remoteCommandPrefix = commandParts.length > 0
    ? commandParts.map(quoteRemoteCommandPart).join(' ')
    : quotePosix(DEFAULT_REMOTE_OPENCLAW_COMMAND);
  return `${remoteCommandPrefix} ${remoteArgs.map(quotePosix).join(' ')}`;
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

function buildWindowsAutoOpenClawCommand(route: IntercomRoute, message: string, sessionId: string): string {
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
  const argsBase64 = Buffer.from(JSON.stringify(remoteArgs), 'utf-8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$argsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${argsBase64}'))`,
    '$openclawArgs = @($argsJson | ConvertFrom-Json)',
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
    options: { windowsAuto?: boolean } = {},
    sessionId = params.sessionId,
  ) => {
    const runForMessage = async (targetRoute: IntercomRoute) => {
      const remoteCommand = options.windowsAuto
        ? buildWindowsAutoOpenClawCommand(targetRoute, message, sessionId)
        : buildRemoteCommand(targetRoute, message, sessionId);
      const invocation = targetRoute.transport === 'ssh' && sshPassword
        ? {
            command: 'ssh2',
            args: [
              `${resolveSshHostAndUsername(targetRoute).username || userInfo().username}@${resolveSshHostAndUsername(targetRoute).host}`,
              remoteCommand,
            ],
          }
        : targetRoute.transport === 'ssh'
          ? buildSshCommand(targetRoute, message, sessionId, options)
          : buildLocalCommand(targetRoute, message, sessionId);
      const commandResult = targetRoute.transport === 'ssh' && sshPassword
        ? await runSsh2Command(targetRoute, sshPassword, message, sessionId, options)
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
        return runMessageOnce(message, route, { windowsAuto: true }, sessionId);
      }
      if (!getIntercomErrorText(error).includes('KTClaw executable not found at /usr/ktclaw')) {
        throw error;
      }
      logger.warn('Retrying intercom command with bundled Linux KTClaw OpenClaw entry', {
        target: params.route.id,
        host: params.route.host,
        agent: params.route.agent,
      });
      return runMessageOnce(message, withBundledLinuxOpenClawCommand(route), options, sessionId);
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
  options: { windowsAuto?: boolean } = {},
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
        ? buildWindowsAutoOpenClawCommand(route, message, sessionId)
        : buildRemoteCommand(route, message, sessionId),
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

async function runSsh2Command(
  route: IntercomRoute,
  password: string,
  message: string,
  sessionId: string,
  options: { windowsAuto?: boolean } = {},
) {
  const startedAt = Date.now();
  const client = await createSsh2Client();
  const resolved = resolveSshHostAndUsername(route);
  const username = resolved.username || userInfo().username;
  const remoteCommand = options.windowsAuto
    ? buildWindowsAutoOpenClawCommand(route, message, sessionId)
    : buildRemoteCommand(route, message, sessionId);
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
  });

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
  const finalMessage = buildIntercomRemoteTaskMessage(sender, task);
  const { invocation, commandResult, sessionId: actualSessionId } = await runIntercomRouteMessage({
    route,
    message: finalMessage,
    sessionId,
  });

  return {
    success: true,
    queued: false,
    taskId: task.taskId,
    task,
    result: normalizeIntercomRemoteTaskResult(commandResult.stdout),
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
    const transfers = await Promise.all(records.map(async (record) => {
      const localStat = await stat(record.localPath || '');
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
