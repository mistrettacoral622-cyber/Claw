import crypto from 'node:crypto';

type JsonObject = Record<string, unknown>;

export type RemoteInstanceAuthMode = 'none' | 'bearer' | 'headers' | 'mixed';

export interface RemoteInstanceHeaderAuth {
  mode: RemoteInstanceAuthMode;
  token?: string;
  headers: Record<string, string>;
}

export interface RemoteAgentCardSkillSnapshot {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  inputModes: string[];
  outputModes: string[];
}

export interface RemoteAgentCardSnapshot {
  name: string;
  description: string;
  url: string;
  protocolVersion?: string;
  provider?: JsonObject | null;
  version?: string;
  documentationUrl?: string;
  capabilities: string[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: RemoteAgentCardSkillSnapshot[];
  raw: JsonObject;
  fetchedAt: string;
}

export interface RemoteInstanceHealthState {
  status: 'unknown' | 'ok' | 'warning' | 'error';
  message?: string;
  testedAt?: string;
  latencyMs?: number;
  httpStatus?: number;
}

export interface RemoteInstanceRecord {
  id: string;
  displayName: string;
  agentCardUrl: string;
  auth: RemoteInstanceHeaderAuth;
  agentCard: RemoteAgentCardSnapshot | null;
  health: RemoteInstanceHealthState;
  createdAt: string;
  updatedAt: string;
}

interface RemoteInstancesStoreShape {
  schemaVersion: number;
  remoteInstances: Record<string, RemoteInstanceRecord>;
}

const REMOTE_INSTANCE_STORE_NAME = 'ktclaw-remote-instances';
const LEGACY_REMOTE_INSTANCE_STORE_NAME = 'clawx-remote-instances';
const REMOTE_INSTANCE_SCHEMA_VERSION = 1;

let remoteInstanceStore:
  | {
    store: RemoteInstancesStoreShape;
    get: (key: string) => unknown;
    set: (key: string | Record<string, unknown>, value?: unknown) => void;
  }
  | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = normalizeString(key);
    const normalizedValue = normalizeString(rawValue);
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    headers[normalizedKey] = normalizedValue;
  }
  return headers;
}

function normalizeAuthMode(value: unknown): RemoteInstanceAuthMode {
  return value === 'bearer' || value === 'headers' || value === 'mixed' ? value : 'none';
}

function normalizeAuth(value: unknown): RemoteInstanceHeaderAuth {
  const raw = isRecord(value) ? value : {};
  const headers = normalizeHeaders(raw.headers);
  const token = normalizeString(raw.token);
  let mode = normalizeAuthMode(raw.mode);

  if ((mode === 'bearer' || mode === 'mixed') && !token) {
    mode = Object.keys(headers).length > 0 ? 'headers' : 'none';
  }
  if (mode === 'headers' && Object.keys(headers).length === 0) {
    mode = token ? 'bearer' : 'none';
  }
  if (mode === 'mixed') {
    if (!token && Object.keys(headers).length === 0) {
      mode = 'none';
    } else if (!token) {
      mode = 'headers';
    } else if (Object.keys(headers).length === 0) {
      mode = 'bearer';
    }
  }

  return {
    mode,
    token: token || undefined,
    headers,
  };
}

function normalizeSkill(value: unknown): RemoteAgentCardSkillSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeString(value.id);
  const name = normalizeString(value.name);
  const description = normalizeString(value.description);

  if (!id || !name || !description) {
    return null;
  }

  return {
    id,
    name,
    description,
    tags: normalizeStringArray(value.tags),
    examples: normalizeStringArray(value.examples),
    inputModes: normalizeStringArray(value.inputModes),
    outputModes: normalizeStringArray(value.outputModes),
  };
}

function normalizeAgentCardSnapshot(value: unknown): RemoteAgentCardSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const raw = value.raw;
  const skills = Array.isArray(value.skills)
    ? value.skills.map(normalizeSkill).filter((item): item is RemoteAgentCardSkillSnapshot => item !== null)
    : [];

  const name = normalizeString(value.name);
  const url = normalizeString(value.url);
  if (!name || !url) {
    return null;
  }

  return {
    name,
    description: normalizeString(value.description),
    url,
    protocolVersion: normalizeString(value.protocolVersion) || undefined,
    provider: isRecord(value.provider) ? value.provider : null,
    version: normalizeString(value.version) || undefined,
    documentationUrl: normalizeString(value.documentationUrl) || undefined,
    capabilities: normalizeStringArray(value.capabilities),
    defaultInputModes: normalizeStringArray(value.defaultInputModes),
    defaultOutputModes: normalizeStringArray(value.defaultOutputModes),
    skills,
    raw: isRecord(raw) ? raw : {},
    fetchedAt: normalizeString(value.fetchedAt) || new Date().toISOString(),
  };
}

function normalizeHealth(value: unknown): RemoteInstanceHealthState {
  const raw = isRecord(value) ? value : {};
  const status = raw.status === 'ok' || raw.status === 'warning' || raw.status === 'error'
    ? raw.status
    : 'unknown';
  const latencyMs = typeof raw.latencyMs === 'number' && Number.isFinite(raw.latencyMs)
    ? raw.latencyMs
    : undefined;
  const httpStatus = typeof raw.httpStatus === 'number' && Number.isFinite(raw.httpStatus)
    ? raw.httpStatus
    : undefined;

  return {
    status,
    message: normalizeString(raw.message) || undefined,
    testedAt: normalizeString(raw.testedAt) || undefined,
    latencyMs,
    httpStatus,
  };
}

function normalizeRemoteInstanceRecord(value: unknown, fallbackId?: string): RemoteInstanceRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeString(value.id) || normalizeString(fallbackId);
  const agentCardUrl = normalizeString(value.agentCardUrl);
  if (!id || !agentCardUrl) {
    return null;
  }

  const displayName = normalizeString(value.displayName)
    || normalizeAgentCardSnapshot(value.agentCard)?.name
    || agentCardUrl;
  const createdAt = normalizeString(value.createdAt) || new Date().toISOString();
  const updatedAt = normalizeString(value.updatedAt) || createdAt;

  return {
    id,
    displayName,
    agentCardUrl,
    auth: normalizeAuth(value.auth),
    agentCard: normalizeAgentCardSnapshot(value.agentCard),
    health: normalizeHealth(value.health),
    createdAt,
    updatedAt,
  };
}

function hasRemoteInstanceStoreData(store: Record<string, unknown>): boolean {
  const remoteInstances = store.remoteInstances;
  return isRecord(remoteInstances) && Object.keys(remoteInstances).length > 0;
}

async function createStoreInstance(name: string, defaults?: Record<string, unknown>) {
  const Store = (await import('electron-store')).default;
  return new Store({
    name,
    defaults,
  });
}

export async function getKTClawRemoteInstanceStore() {
  if (!remoteInstanceStore) {
    remoteInstanceStore = await createStoreInstance(REMOTE_INSTANCE_STORE_NAME, {
      schemaVersion: 0,
      remoteInstances: {} as Record<string, RemoteInstanceRecord>,
    }) as typeof remoteInstanceStore;

    const currentStoreData = remoteInstanceStore.store as Record<string, unknown>;
    if (!hasRemoteInstanceStoreData(currentStoreData)) {
      const legacyStore = await createStoreInstance(LEGACY_REMOTE_INSTANCE_STORE_NAME);
      const legacyStoreData = legacyStore.store as Record<string, unknown>;
      if (hasRemoteInstanceStoreData(legacyStoreData)) {
        remoteInstanceStore.set(legacyStoreData);
      }
    }
  }

  return remoteInstanceStore;
}

export type RemoteInstanceCreateInput = {
  id?: string;
  displayName?: string;
  agentCardUrl: string;
  auth?: Partial<RemoteInstanceHeaderAuth>;
  agentCard?: RemoteAgentCardSnapshot | null;
  health?: Partial<RemoteInstanceHealthState>;
};

export type RemoteInstanceUpdateInput = Partial<Pick<RemoteInstanceRecord, 'displayName' | 'agentCardUrl' | 'agentCard' | 'health'>> & {
  auth?: Partial<RemoteInstanceHeaderAuth>;
};

function mergeHealth(
  current: RemoteInstanceHealthState,
  patch?: Partial<RemoteInstanceHealthState>,
): RemoteInstanceHealthState {
  if (!patch) {
    return current;
  }

  return normalizeHealth({
    ...current,
    ...patch,
  });
}

function mergeAuth(
  current: RemoteInstanceHeaderAuth,
  patch?: Partial<RemoteInstanceHeaderAuth>,
): RemoteInstanceHeaderAuth {
  if (!patch) {
    return current;
  }

  const nextHeaders = patch.headers === undefined
    ? current.headers
    : normalizeHeaders(patch.headers);

  return normalizeAuth({
    ...current,
    ...patch,
    headers: nextHeaders,
  });
}

async function readRemoteInstanceMap(): Promise<Record<string, RemoteInstanceRecord>> {
  const store = await getKTClawRemoteInstanceStore();
  const raw = store.get('remoteInstances');
  if (!isRecord(raw)) {
    return {};
  }

  const normalized: Record<string, RemoteInstanceRecord> = {};
  for (const [id, value] of Object.entries(raw)) {
    const record = normalizeRemoteInstanceRecord(value, id);
    if (record) {
      normalized[record.id] = record;
    }
  }
  return normalized;
}

function writeRemoteInstanceMap(
  store: Awaited<ReturnType<typeof getKTClawRemoteInstanceStore>>,
  remoteInstances: Record<string, RemoteInstanceRecord>,
): void {
  store.set('remoteInstances', remoteInstances);
  store.set('schemaVersion', REMOTE_INSTANCE_SCHEMA_VERSION);
}

export function createRemoteInstanceId(): string {
  return `remote-${crypto.randomUUID()}`;
}

export async function listRemoteInstances(): Promise<RemoteInstanceRecord[]> {
  const remoteInstances = await readRemoteInstanceMap();
  return Object.values(remoteInstances)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function getRemoteInstance(instanceId: string): Promise<RemoteInstanceRecord | null> {
  const remoteInstances = await readRemoteInstanceMap();
  return remoteInstances[instanceId] ?? null;
}

export async function createRemoteInstance(input: RemoteInstanceCreateInput): Promise<RemoteInstanceRecord> {
  const store = await getKTClawRemoteInstanceStore();
  const remoteInstances = await readRemoteInstanceMap();
  const now = new Date().toISOString();
  const id = normalizeString(input.id) || createRemoteInstanceId();
  const agentCard = input.agentCard ? normalizeAgentCardSnapshot(input.agentCard) : null;
  const record: RemoteInstanceRecord = {
    id,
    displayName: normalizeString(input.displayName) || agentCard?.name || normalizeString(input.agentCardUrl),
    agentCardUrl: normalizeString(input.agentCardUrl),
    auth: mergeAuth({ mode: 'none', headers: {} }, input.auth),
    agentCard,
    health: mergeHealth({ status: 'unknown' }, input.health),
    createdAt: now,
    updatedAt: now,
  };

  remoteInstances[id] = record;
  writeRemoteInstanceMap(store, remoteInstances);
  return record;
}

export async function updateRemoteInstance(
  instanceId: string,
  patch: RemoteInstanceUpdateInput,
): Promise<RemoteInstanceRecord | null> {
  const store = await getKTClawRemoteInstanceStore();
  const remoteInstances = await readRemoteInstanceMap();
  const current = remoteInstances[instanceId];
  if (!current) {
    return null;
  }

  const nextAgentCard = patch.agentCard === undefined
    ? current.agentCard
    : normalizeAgentCardSnapshot(patch.agentCard);

  const updated: RemoteInstanceRecord = {
    ...current,
    displayName: patch.displayName === undefined
      ? current.displayName
      : (normalizeString(patch.displayName) || nextAgentCard?.name || current.displayName),
    agentCardUrl: patch.agentCardUrl === undefined
      ? current.agentCardUrl
      : normalizeString(patch.agentCardUrl),
    auth: mergeAuth(current.auth, patch.auth),
    agentCard: nextAgentCard,
    health: mergeHealth(current.health, patch.health),
    updatedAt: new Date().toISOString(),
  };

  remoteInstances[instanceId] = updated;
  writeRemoteInstanceMap(store, remoteInstances);
  return updated;
}

export async function deleteRemoteInstance(instanceId: string): Promise<boolean> {
  const store = await getKTClawRemoteInstanceStore();
  const remoteInstances = await readRemoteInstanceMap();
  if (!remoteInstances[instanceId]) {
    return false;
  }

  delete remoteInstances[instanceId];
  writeRemoteInstanceMap(store, remoteInstances);
  return true;
}
