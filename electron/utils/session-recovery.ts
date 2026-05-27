import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, normalize, resolve } from 'node:path';
import { getOpenClawConfigDir } from './paths';

type SourceKind = 'current' | 'legacy';

type JsonRecord = Record<string, unknown>;

export interface RecoverableChatSession {
  key: string;
  label?: string;
  displayName?: string;
  thinkingLevel?: string;
  model?: string;
  updatedAt?: number;
  agentId?: string;
  recovered?: boolean;
}

export interface RecoverableChatMessage {
  role: 'user' | 'assistant' | 'system' | 'toolresult';
  content: unknown;
  timestamp?: number;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
}

interface SessionIndexEntry {
  sessionKey: string;
  record: JsonRecord;
}

interface ResolvedSessionEntry {
  session: RecoverableChatSession;
  filePath?: string;
  source: SourceKind;
}

function parseTimeMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readString(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNestedRecord(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

function uniqueRecoveryRoots(): Array<{ root: string; source: SourceKind }> {
  const current = getOpenClawConfigDir();
  const candidates: Array<{ root: string; source: SourceKind }> = [
    { root: current, source: 'current' },
    { root: join(homedir(), '.openclaw'), source: 'legacy' },
    { root: join(homedir(), '.ktclaw', 'openclaw'), source: 'legacy' },
    { root: join(homedir(), '.clawx', 'openclaw'), source: 'legacy' },
  ];

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = normalize(resolve(candidate.root)).toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function extractSessionIndexEntries(index: JsonRecord): SessionIndexEntry[] {
  const directEntries = Object.entries(index)
    .filter(([key, value]) => key !== 'sessions' && value && typeof value === 'object' && !Array.isArray(value))
    .map(([key, value]) => ({
      sessionKey: key,
      record: value as JsonRecord,
    }));

  const arrayEntries = Array.isArray(index.sessions)
    ? index.sessions
      .filter((entry): entry is JsonRecord => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      .map((entry) => ({
        sessionKey: readString(entry, 'key') || readString(entry, 'sessionKey') || '',
        record: entry,
      }))
      .filter((entry) => entry.sessionKey)
    : [];

  return [...directEntries, ...arrayEntries];
}

function resolveSessionFilePath(record: JsonRecord, sessionsDir: string): string | undefined {
  const directPath =
    readString(record, 'sessionFile')
    || readString(record, 'file')
    || readString(record, 'fileName')
    || readString(record, 'path');

  if (directPath) {
    return isAbsolutePath(directPath) ? directPath : join(sessionsDir, directPath);
  }

  const sessionId = readString(record, 'sessionId') || readString(record, 'id');
  if (!sessionId) return undefined;
  return join(sessionsDir, sessionId.endsWith('.jsonl') ? sessionId : `${sessionId}.jsonl`);
}

function deriveDisplayName(sessionKey: string, record: JsonRecord): string | undefined {
  const explicit =
    readString(record, 'displayName')
    || readString(record, 'label')
    || readString(record, 'subject');
  if (explicit) return explicit;
  if (sessionKey.endsWith(':main')) return undefined;

  const origin = readNestedRecord(record, 'origin');
  const deliveryContext = readNestedRecord(record, 'deliveryContext');
  return readString(origin, 'label')
    || readString(deliveryContext, 'to')
    || readString(record, 'lastTo')
    || sessionKey.split(':').slice(2).join(':')
    || undefined;
}

async function resolveIndexedSession(params: {
  agentId: string;
  entry: SessionIndexEntry;
  sessionsDir: string;
  source: SourceKind;
}): Promise<ResolvedSessionEntry | null> {
  const { agentId, entry, sessionsDir, source } = params;
  const sessionKey = entry.sessionKey.trim();
  if (!sessionKey || sessionKey.endsWith('.deleted')) return null;

  const filePath = resolveSessionFilePath(entry.record, sessionsDir);
  let fileUpdatedAt: number | undefined;
  if (filePath) {
    try {
      fileUpdatedAt = (await stat(filePath)).mtimeMs;
    } catch {
      fileUpdatedAt = undefined;
    }
  }

  return {
    filePath,
    source,
    session: {
      key: sessionKey,
      label: readString(entry.record, 'label'),
      displayName: deriveDisplayName(sessionKey, entry.record),
      thinkingLevel: readString(entry.record, 'thinkingLevel'),
      model: readString(entry.record, 'model') || readString(entry.record, 'modelProvider'),
      updatedAt: parseTimeMs(entry.record.updatedAt) ?? fileUpdatedAt,
      agentId,
      recovered: source === 'legacy',
    },
  };
}

async function readIndexedSessionsForAgent(params: {
  root: string;
  source: SourceKind;
  agentId: string;
}): Promise<ResolvedSessionEntry[]> {
  const { root, source, agentId } = params;
  const sessionsDir = join(root, 'agents', agentId, 'sessions');
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');
  const raw = await readFile(sessionsJsonPath, 'utf8').catch(() => '');
  if (!raw.trim()) return [];

  let parsed: JsonRecord;
  try {
    parsed = JSON.parse(raw) as JsonRecord;
  } catch {
    return [];
  }

  const entries = await Promise.all(
    extractSessionIndexEntries(parsed).map((entry) => resolveIndexedSession({
      agentId,
      entry,
      sessionsDir,
      source,
    })),
  );
  return entries.filter((entry): entry is ResolvedSessionEntry => entry != null);
}

function isVisibleTranscriptFile(fileName: string): boolean {
  return fileName.endsWith('.jsonl') && !fileName.endsWith('.deleted.jsonl') && !fileName.includes('.jsonl.reset.');
}

async function readLooseSessionsForAgent(params: {
  root: string;
  source: SourceKind;
  agentId: string;
  indexedFilePaths: Set<string>;
  indexedKeys: Set<string>;
}): Promise<ResolvedSessionEntry[]> {
  const { root, source, agentId, indexedFilePaths, indexedKeys } = params;
  const sessionsDir = join(root, 'agents', agentId, 'sessions');
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const recovered: ResolvedSessionEntry[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !isVisibleTranscriptFile(entry.name)) continue;
    const filePath = join(sessionsDir, entry.name);
    const normalizedFile = normalize(resolve(filePath)).toLowerCase();
    if (indexedFilePaths.has(normalizedFile)) continue;

    const sessionId = basename(entry.name, '.jsonl');
    const sessionKey = `agent:${agentId}:recovered:${sessionId}`;
    if (indexedKeys.has(sessionKey)) continue;

    let updatedAt: number | undefined;
    try {
      updatedAt = (await stat(filePath)).mtimeMs;
    } catch {
      updatedAt = undefined;
    }

    recovered.push({
      filePath,
      source,
      session: {
        key: sessionKey,
        displayName: `Recovered ${sessionId.slice(0, 8)}`,
        updatedAt,
        agentId,
        recovered: true,
      },
    });
  }

  return recovered;
}

async function discoverSessionEntries(): Promise<ResolvedSessionEntry[]> {
  const allEntries: ResolvedSessionEntry[] = [];

  for (const candidate of uniqueRecoveryRoots()) {
    const agentsDir = join(candidate.root, 'agents');
    if (!(await pathExists(agentsDir))) continue;
    const agentEntries = await readdir(agentsDir, { withFileTypes: true }).catch(() => []);

    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      const indexedEntries = await readIndexedSessionsForAgent({
        root: candidate.root,
        source: candidate.source,
        agentId: agentEntry.name,
      });
      allEntries.push(...indexedEntries);

      const indexedFilePaths = new Set(
        indexedEntries
          .map((entry) => entry.filePath)
          .filter((value): value is string => Boolean(value))
          .map((value) => normalize(resolve(value)).toLowerCase()),
      );
      const indexedKeys = new Set(indexedEntries.map((entry) => entry.session.key));
      allEntries.push(...await readLooseSessionsForAgent({
        root: candidate.root,
        source: candidate.source,
        agentId: agentEntry.name,
        indexedFilePaths,
        indexedKeys,
      }));
    }
  }

  const byKey = new Map<string, ResolvedSessionEntry>();
  for (const entry of allEntries) {
    const existing = byKey.get(entry.session.key);
    if (!existing) {
      byKey.set(entry.session.key, entry);
      continue;
    }

    const existingRank = existing.source === 'current' ? 2 : 1;
    const entryRank = entry.source === 'current' ? 2 : 1;
    const existingUpdatedAt = existing.session.updatedAt ?? 0;
    const entryUpdatedAt = entry.session.updatedAt ?? 0;
    if (entryRank > existingRank || (entryRank === existingRank && entryUpdatedAt > existingUpdatedAt)) {
      byKey.set(entry.session.key, entry);
    }
  }

  return [...byKey.values()].sort((left, right) => (
    (right.session.updatedAt ?? 0) - (left.session.updatedAt ?? 0)
      || left.session.key.localeCompare(right.session.key)
  ));
}

function normalizeRole(role: unknown): RecoverableChatMessage['role'] | null {
  const normalized = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (normalized === 'user' || normalized === 'assistant' || normalized === 'system') {
    return normalized;
  }
  if (normalized === 'toolresult' || normalized === 'tool_result') {
    return 'toolresult';
  }
  return null;
}

function normalizeMessageLine(line: JsonRecord): RecoverableChatMessage | null {
  const rawMessage = line.message && typeof line.message === 'object' && !Array.isArray(line.message)
    ? line.message as JsonRecord
    : line;
  const role = normalizeRole(rawMessage.role);
  if (!role) return null;

  return {
    role,
    content: rawMessage.content ?? '',
    timestamp: parseTimeMs(rawMessage.timestamp) ?? parseTimeMs(line.timestamp),
    id: readString(rawMessage, 'id') || readString(line, 'id'),
    toolCallId: readString(rawMessage, 'toolCallId') || readString(rawMessage, 'tool_call_id'),
    toolName: readString(rawMessage, 'toolName') || readString(rawMessage, 'name'),
    details: rawMessage.details,
    isError: typeof rawMessage.isError === 'boolean' ? rawMessage.isError : undefined,
  };
}

async function readTranscriptMessages(filePath: string, limit: number): Promise<RecoverableChatMessage[]> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw.trim()) return [];
  const messages: RecoverableChatMessage[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JsonRecord;
      const message = normalizeMessageLine(parsed);
      if (message) messages.push(message);
    } catch {
      // Ignore malformed transcript lines and continue restoring valid turns.
    }
  }

  return Number.isFinite(limit) && limit > 0 ? messages.slice(-limit) : messages;
}

export async function listRecoverableChatSessions(): Promise<RecoverableChatSession[]> {
  const entries = await discoverSessionEntries();
  return entries.map((entry) => entry.session);
}

export async function readRecoverableChatHistory(
  sessionKey: string,
  limit = 200,
): Promise<{ messages: RecoverableChatMessage[]; recovered: boolean }> {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return { messages: [], recovered: false };
  }

  const entry = (await discoverSessionEntries()).find((candidate) => candidate.session.key === normalizedSessionKey);
  if (!entry?.filePath) {
    return { messages: [], recovered: false };
  }

  return {
    messages: await readTranscriptMessages(entry.filePath, limit),
    recovered: entry.source === 'legacy' || entry.session.recovered === true,
  };
}
