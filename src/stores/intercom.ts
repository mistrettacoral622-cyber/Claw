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
  error: string | null;
  lastSendResult: IntercomSendResult | null;
  fetchIntercom: (options?: { force?: boolean }) => Promise<void>;
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
  error: null,
  lastSendResult: null,

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
