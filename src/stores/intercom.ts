import { create } from 'zustand';
import { AppError } from '@/lib/error-model';
import { hostApiFetch } from '@/lib/host-api';

export type IntercomTransport = 'local' | 'ssh' | 'nats';

export type IntercomRoute = {
  id: string;
  displayName: string;
  host: string;
  agent: string;
  transport: IntercomTransport;
  sessionId: string;
  enabled: boolean;
  sshUser: string | null;
  sshPort: number | null;
  sshPasswordConfigured: boolean;
  remoteCommand: string | null;
  source: 'config' | 'local';
};

export type IntercomSelfConfig = {
  host: string;
  sshUser: string | null;
  sshPort: number;
  agentId: string;
  sessionId: string;
  remoteCommand: string;
  routeIdExample: string;
  displayNameExample: string;
};

export type IntercomHostReadinessStatus = 'ok' | 'warning' | 'missing' | 'unknown';

export type IntercomHostReadinessCheck = {
  id: 'lan-host' | 'ssh-user' | 'agent' | 'ssh-listener' | 'firewall' | 'remote-command';
  status: IntercomHostReadinessStatus;
  title: string;
  detail: string;
};

export type IntercomHostReadiness = {
  ready: boolean;
  platform: string;
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
};

export type IntercomHostPrepareResult = {
  success: boolean;
  started: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  status: IntercomHostReadiness;
};

export type IntercomRouteInput = {
  id: string;
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
};

export type IntercomSendInput = {
  target: string;
  sender: string;
  message: string;
  sessionId?: string;
};

export type IntercomSendResult = {
  success: boolean;
  queued: boolean;
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
  durationMs: number | null;
};

export type IntercomProtocolInstallResult = {
  success: true;
  updated: string[];
  skipped: string[];
};

type IntercomState = {
  routes: IntercomRoute[];
  localAgents: Array<{ id: string; name: string }>;
  localHost: string | null;
  defaultSessionId: string;
  selfConfig: IntercomSelfConfig | null;
  loading: boolean;
  saving: boolean;
  sending: boolean;
  installingProtocol: boolean;
  preparingHost: boolean;
  error: string | null;
  lastSendResult: IntercomSendResult | null;
  hostReadiness: IntercomHostReadiness | null;
  fetchIntercom: (options?: { force?: boolean }) => Promise<void>;
  fetchHostReadiness: () => Promise<void>;
  prepareHost: () => Promise<IntercomHostPrepareResult>;
  upsertRoute: (input: IntercomRouteInput) => Promise<void>;
  deleteRoute: (routeId: string) => Promise<void>;
  sendMessage: (input: IntercomSendInput) => Promise<IntercomSendResult>;
  installProtocol: () => Promise<IntercomProtocolInstallResult>;
  clearError: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readTransport(value: unknown): IntercomTransport {
  return value === 'ssh' || value === 'nats' ? value : 'local';
}

function normalizeRoute(value: unknown): IntercomRoute | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id);
  const host = readString(value.host);
  const agent = readString(value.agent);
  if (!id || !host || !agent) {
    return null;
  }
  return {
    id,
    displayName: readString(value.displayName) ?? id,
    host,
    agent,
    transport: readTransport(value.transport),
    sessionId: readString(value.sessionId) ?? 'intercom',
    enabled: value.enabled !== false,
    sshUser: readString(value.sshUser),
    sshPort: typeof value.sshPort === 'number' && Number.isFinite(value.sshPort) ? value.sshPort : null,
    sshPasswordConfigured: value.sshPasswordConfigured === true,
    remoteCommand: readString(value.remoteCommand),
    source: value.source === 'config' ? 'config' : 'local',
  };
}

function normalizeSelfConfig(value: unknown): IntercomSelfConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  const host = readString(value.host);
  const agentId = readString(value.agentId);
  if (!host || !agentId) {
    return null;
  }

  return {
    host,
    sshUser: readString(value.sshUser),
    sshPort: typeof value.sshPort === 'number' && Number.isFinite(value.sshPort) ? value.sshPort : 22,
    agentId,
    sessionId: readString(value.sessionId) ?? 'intercom',
    remoteCommand: readString(value.remoteCommand) ?? 'openclaw',
    routeIdExample: readString(value.routeIdExample) ?? agentId,
    displayNameExample: readString(value.displayNameExample) ?? agentId,
  };
}

function readHostCheckId(value: unknown): IntercomHostReadinessCheck['id'] | null {
  return value === 'lan-host'
    || value === 'ssh-user'
    || value === 'agent'
    || value === 'ssh-listener'
    || value === 'firewall'
    || value === 'remote-command'
    ? value
    : null;
}

function readHostCheckStatus(value: unknown): IntercomHostReadinessStatus {
  return value === 'ok' || value === 'warning' || value === 'missing' || value === 'unknown'
    ? value
    : 'unknown';
}

function normalizeHostReadinessCheck(value: unknown): IntercomHostReadinessCheck | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readHostCheckId(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    status: readHostCheckStatus(value.status),
    title: readString(value.title) ?? id,
    detail: readString(value.detail) ?? '',
  };
}

function normalizeHostReadiness(value: unknown): IntercomHostReadiness | null {
  if (!isRecord(value)) {
    return null;
  }
  const host = readString(value.host);
  const agentId = readString(value.agentId);
  if (!host || !agentId) {
    return null;
  }
  return {
    ready: value.ready === true,
    platform: readString(value.platform) ?? 'unknown',
    canPrepare: value.canPrepare === true,
    needsAdmin: value.needsAdmin === true,
    host,
    sshUser: readString(value.sshUser),
    sshPort: typeof value.sshPort === 'number' && Number.isFinite(value.sshPort) ? value.sshPort : 22,
    agentId,
    sessionId: readString(value.sessionId) ?? 'intercom',
    remoteCommand: readString(value.remoteCommand) ?? 'openclaw',
    checks: Array.isArray(value.checks)
      ? value.checks.map(normalizeHostReadinessCheck).filter((entry): entry is IntercomHostReadinessCheck => entry !== null)
      : [],
    prepareCommandPreview: readString(value.prepareCommandPreview),
  };
}

function normalizeSnapshot(value: unknown) {
  const row = isRecord(value) ? value : {};
  const localAgents = Array.isArray(row.localAgents)
    ? row.localAgents
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }
          const id = readString(entry.id);
          if (!id) {
            return null;
          }
          return { id, name: readString(entry.name) ?? id };
        })
        .filter((entry): entry is { id: string; name: string } => entry !== null)
    : [];

  return {
    routes: Array.isArray(row.routes)
      ? row.routes.map(normalizeRoute).filter((entry): entry is IntercomRoute => entry !== null)
      : [],
    localAgents,
    localHost: readString(row.localHost),
    defaultSessionId: readString(row.defaultSessionId) ?? 'intercom',
    selfConfig: normalizeSelfConfig(row.selfConfig),
  };
}

function normalizeHostPrepareResult(value: unknown): IntercomHostPrepareResult {
  const row = isRecord(value) ? value : {};
  return {
    success: row.success === true,
    started: row.started === true,
    stdout: readString(row.stdout) ?? '',
    stderr: readString(row.stderr) ?? '',
    error: readString(row.error),
    status: normalizeHostReadiness(row.status) ?? normalizeHostReadiness(row) ?? {
      ready: false,
      platform: 'unknown',
      canPrepare: false,
      needsAdmin: false,
      host: '',
      sshUser: null,
      sshPort: 22,
      agentId: 'main',
      sessionId: 'intercom',
      remoteCommand: 'openclaw',
      checks: [],
      prepareCommandPreview: null,
    },
  };
}

function normalizeProtocolInstallResult(value: unknown): IntercomProtocolInstallResult {
  const row = isRecord(value) ? value : {};
  return {
    success: true,
    updated: Array.isArray(row.updated) ? row.updated.map(readString).filter((entry): entry is string => entry !== null) : [],
    skipped: Array.isArray(row.skipped) ? row.skipped.map(readString).filter((entry): entry is string => entry !== null) : [],
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(readString).filter((entry): entry is string => entry !== null)
    : [];
}

function normalizeSendResult(value: unknown): IntercomSendResult {
  const row = isRecord(value) ? value : {};
  return {
    success: row.success !== false,
    queued: row.queued === true,
    target: readString(row.target) ?? '',
    sender: readString(row.sender) ?? '',
    transport: readTransport(row.transport),
    host: readString(row.host) ?? '',
    agent: readString(row.agent) ?? '',
    sessionId: readString(row.sessionId) ?? 'intercom',
    command: readString(row.command) ?? '',
    args: normalizeStringArray(row.args),
    exitCode: typeof row.exitCode === 'number' ? row.exitCode : null,
    stdout: readString(row.stdout) ?? '',
    stderr: readString(row.stderr) ?? '',
    durationMs: typeof row.durationMs === 'number' ? row.durationMs : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readIntercomErrorPayload(error: unknown): unknown {
  if (!(error instanceof AppError)) {
    return null;
  }
  const json = error.details?.json;
  return isRecord(json) && json.success === false ? json : null;
}

export const useIntercomStore = create<IntercomState>((set, get) => ({
  routes: [],
  localAgents: [],
  localHost: null,
  defaultSessionId: 'intercom',
  selfConfig: null,
  loading: false,
  saving: false,
  sending: false,
  installingProtocol: false,
  preparingHost: false,
  error: null,
  lastSendResult: null,
  hostReadiness: null,

  fetchIntercom: async (options) => {
    if (get().loading && !options?.force) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const response = await hostApiFetch('/api/intercom');
      set({
        ...normalizeSnapshot(response),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: toErrorMessage(error) });
    }
  },

  fetchHostReadiness: async () => {
    try {
      const response = await hostApiFetch('/api/intercom/host-readiness');
      set({ hostReadiness: normalizeHostReadiness(response), error: null });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  prepareHost: async () => {
    set({ preparingHost: true, error: null });
    try {
      const response = await hostApiFetch('/api/intercom/prepare-host', {
        method: 'POST',
      });
      const result = normalizeHostPrepareResult(response);
      set({ preparingHost: false, hostReadiness: result.status });
      return result;
    } catch (error) {
      set({ preparingHost: false, error: toErrorMessage(error) });
      throw error;
    }
  },

  upsertRoute: async (input) => {
    set({ saving: true, error: null });
    try {
      const response = await hostApiFetch('/api/intercom/routes', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      set({ ...normalizeSnapshot(response), saving: false });
    } catch (error) {
      set({ saving: false, error: toErrorMessage(error) });
      throw error;
    }
  },

  deleteRoute: async (routeId) => {
    set({ saving: true, error: null });
    try {
      const response = await hostApiFetch(`/api/intercom/routes/${encodeURIComponent(routeId)}`, {
        method: 'DELETE',
      });
      set({ ...normalizeSnapshot(response), saving: false });
    } catch (error) {
      set({ saving: false, error: toErrorMessage(error) });
      throw error;
    }
  },

  sendMessage: async (input) => {
    set({ sending: true, error: null, lastSendResult: null });
    try {
      const response = await hostApiFetch('/api/intercom/send', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      const result = normalizeSendResult(response);
      set({ sending: false, lastSendResult: result });
      return result;
    } catch (error) {
      const failedResult = normalizeSendResult(readIntercomErrorPayload(error));
      set({
        sending: false,
        error: toErrorMessage(error),
        lastSendResult: failedResult.success === false ? failedResult : null,
      });
      throw error;
    }
  },

  installProtocol: async () => {
    set({ installingProtocol: true, error: null });
    try {
      const response = await hostApiFetch('/api/intercom/install-protocol', {
        method: 'POST',
      });
      const result = normalizeProtocolInstallResult(response);
      set({ installingProtocol: false });
      return result;
    } catch (error) {
      set({ installingProtocol: false, error: toErrorMessage(error) });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
