import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';

export type RemoteInstanceAuthMode = 'none' | 'bearer' | 'headers' | 'mixed';

export type RemoteAgentCardCapability = {
  id: string;
  label: string;
  description: string | null;
};

export type RemoteAgentCardSummary = {
  name: string | null;
  description: string | null;
  version: string | null;
  url: string | null;
  capabilities: RemoteAgentCardCapability[];
  skills: string[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
};

export type RemoteInstanceTestResult = {
  ok: boolean;
  status: string;
  message: string | null;
  checkedAt: string | null;
};

export type RemoteInstance = {
  id: string;
  displayName: string | null;
  agentCardUrl: string;
  authMode: RemoteInstanceAuthMode;
  bearerToken: string | null;
  headers: Record<string, string>;
  agentCard: RemoteAgentCardSummary | null;
  lastTest: RemoteInstanceTestResult | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type RemoteInstanceSelfApiKey = {
  label: string;
  maskedKey: string;
};

export type RemoteInstanceSelfAccessKey = {
  label: string;
  key: string;
  header: string;
};

export type RemoteInstanceSelfAgentCard = {
  name: string | null;
  description: string | null;
};

export type RemoteInstanceSelfUrls = {
  localAgentCardUrl: string | null;
  localA2AEndpointUrl: string | null;
  lanAgentCardUrl: string | null;
  lanA2AEndpointUrl: string | null;
  tailscaleAgentCardUrlHint: string | null;
  tailscaleA2AEndpointUrlHint: string | null;
};

export type RemoteInstanceSelf = {
  enabled: boolean;
  gateway: {
    state: string | null;
    port: number | null;
  };
  network: {
    mode: 'local' | 'lan';
    bindMode: string | null;
    tailscaleMode: string | null;
    customBindHost: string | null;
    externallyReachable: boolean;
    requiresFirewall: boolean;
  };
  inbound: {
    agentCard: RemoteInstanceSelfAgentCard;
    allowUnauthenticated: boolean;
    apiKeys: RemoteInstanceSelfApiKey[];
  };
  urls: RemoteInstanceSelfUrls;
  share: {
    url: string | null;
    headerName: string | null;
    headerValueExample: string | null;
    headerLineExample: string | null;
  };
  newAccessKey: RemoteInstanceSelfAccessKey | null;
  hints: {
    lan: string | null;
    tailscale: string | null;
  };
  reloadRequested: boolean;
};

export type RemoteInstanceCreateInput = {
  agentCardUrl: string;
  displayName?: string;
};

export type RemoteInstanceUpdateInput = {
  displayName?: string;
  agentCardUrl?: string;
  authMode?: RemoteInstanceAuthMode;
  bearerToken?: string | null;
  headers?: Record<string, string>;
};

export type RemoteInstanceSelfUpdateInput = {
  enabled?: boolean;
  agentCardName?: string;
  agentCardDescription?: string;
  allowUnauthenticated?: boolean;
  networkMode?: 'local' | 'lan';
};

type RemoteInstancesBusyState = {
  deleting?: boolean;
  refreshing?: boolean;
  saving?: boolean;
  sending?: boolean;
  testing?: boolean;
};

export type RemoteConversationRole = 'user' | 'assistant' | 'system';

export type RemoteConversationMessageStatus = 'sending' | 'sent' | 'received' | 'error';

export type RemoteConversationMessage = {
  id: string;
  role: RemoteConversationRole;
  content: string;
  createdAt: string;
  status: RemoteConversationMessageStatus;
  contextId: string | null;
  taskId: string | null;
  error: string | null;
};

export type RemoteInstanceConversationThread = {
  instanceId: string;
  messages: RemoteConversationMessage[];
  contextId: string | null;
  taskId: string | null;
  updatedAt: string | null;
};

export type RemoteMessageSendInput = {
  message: string;
};

type RemoteInstancesState = {
  instances: RemoteInstance[];
  selectedInstanceId: string | null;
  threadsByInstanceId: Record<string, RemoteInstanceConversationThread>;
  self: RemoteInstanceSelf | null;
  selfLoading: boolean;
  selfLoaded: boolean;
  selfSaving: boolean;
  selfGeneratingKey: boolean;
  selfRevokingKeyByLabel: Record<string, boolean>;
  loading: boolean;
  loaded: boolean;
  creating: boolean;
  error: string | null;
  busyById: Record<string, RemoteInstancesBusyState>;
  clearError: () => void;
  reset: () => void;
  selectInstance: (id: string | null) => void;
  clearSelfNewAccessKey: () => void;
  fetchSelf: (options?: { force?: boolean }) => Promise<void>;
  updateSelf: (input: RemoteInstanceSelfUpdateInput) => Promise<RemoteInstanceSelf>;
  generateSelfAccessKey: (label: string) => Promise<RemoteInstanceSelfAccessKey>;
  revokeSelfAccessKey: (label: string) => Promise<void>;
  fetchInstances: (options?: { force?: boolean }) => Promise<void>;
  createInstance: (input: RemoteInstanceCreateInput) => Promise<RemoteInstance>;
  updateInstance: (id: string, input: RemoteInstanceUpdateInput) => Promise<RemoteInstance>;
  deleteInstance: (id: string) => Promise<void>;
  refreshAgentCard: (id: string) => Promise<RemoteInstance>;
  sendRemoteMessage: (
    id: string,
    input: RemoteMessageSendInput,
  ) => Promise<RemoteConversationMessage | null>;
  testConnection: (id: string) => Promise<RemoteInstanceTestResult>;
};

const REMOTE_CONVERSATIONS_STORAGE_KEY = 'ktclaw:remote-instance-conversations';

const INITIAL_STATE = {
  instances: [] as RemoteInstance[],
  selectedInstanceId: null as string | null,
  loading: false,
  loaded: false,
  creating: false,
  self: null as RemoteInstanceSelf | null,
  selfLoading: false,
  selfLoaded: false,
  selfSaving: false,
  selfGeneratingKey: false,
  selfRevokingKeyByLabel: {} as Record<string, boolean>,
  error: null as string | null,
  busyById: {} as Record<string, RemoteInstancesBusyState>,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => readTrimmedString(entry))
    .filter((entry): entry is string => entry != null);
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }

  if (Array.isArray(value)) {
    const pairs = value
      .map((entry) => {
        if (!Array.isArray(entry) || entry.length < 2) {
          return null;
        }

        const key = readTrimmedString(entry[0]);
        const headerValue = readTrimmedString(entry[1]);

        return key && headerValue ? [key, headerValue] : null;
      })
      .filter((entry): entry is [string, string] => entry != null);

    return Object.fromEntries(pairs);
  }

  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, headerValue]) => {
        const normalizedKey = readTrimmedString(key);
        const normalizedValue = readTrimmedString(headerValue);
        return normalizedKey && normalizedValue ? [normalizedKey, normalizedValue] : null;
      })
      .filter((entry): entry is [string, string] => entry != null),
  );
}

function normalizeCapability(value: unknown): RemoteAgentCardCapability | null {
  if (typeof value === 'string') {
    const label = readTrimmedString(value);
    return label
      ? {
          id: label,
          label,
          description: null,
        }
      : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const label =
    readTrimmedString(value.label) ??
    readTrimmedString(value.name) ??
    readTrimmedString(value.title) ??
    readTrimmedString(value.id);

  if (!label) {
    return null;
  }

  return {
    id: readTrimmedString(value.id) ?? label,
    label,
    description: readTrimmedString(value.description),
  };
}

function normalizeAgentCard(value: unknown): RemoteAgentCardSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities
        .map((entry) => normalizeCapability(entry))
        .filter((entry): entry is RemoteAgentCardCapability => entry != null)
    : [];

  const skills = Array.isArray(value.skills)
    ? value.skills
        .map((entry) => {
          if (typeof entry === 'string') {
            return readTrimmedString(entry);
          }

          if (isRecord(entry)) {
            return (
              readTrimmedString(entry.label) ??
              readTrimmedString(entry.name) ??
              readTrimmedString(entry.id)
            );
          }

          return null;
        })
        .filter((entry): entry is string => entry != null)
    : [];

  return {
    name: readTrimmedString(value.name),
    description: readTrimmedString(value.description),
    version: readTrimmedString(value.version),
    url: readTrimmedString(value.url),
    capabilities,
    skills,
    defaultInputModes: readStringArray(value.defaultInputModes),
    defaultOutputModes: readStringArray(value.defaultOutputModes),
  };
}

function normalizeTestResult(value: unknown): RemoteInstanceTestResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const status = readTrimmedString(value.status);
  const ok = typeof value.ok === 'boolean'
    ? value.ok
    : typeof value.success === 'boolean'
      ? value.success
      : null;

  if (status == null && ok == null) {
    return null;
  }

  const normalizedStatus = status ?? (ok ? 'ok' : 'unknown');
  return {
    ok: ok ?? normalizedStatus === 'ok',
    status: normalizedStatus,
    message: readTrimmedString(value.message),
    checkedAt: readTrimmedString(value.checkedAt) ?? readTrimmedString(value.testedAt),
  };
}

function createMessageId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeTimestamp(value: unknown, fallback = new Date().toISOString()): string {
  return readTrimmedString(value) ?? fallback;
}

function normalizeConversationMessage(value: unknown): RemoteConversationMessage | null {
  if (!isRecord(value)) {
    return null;
  }

  const role = readTrimmedString(value.role);
  const normalizedRole: RemoteConversationRole =
    role === 'assistant' || role === 'system' || role === 'user' ? role : 'assistant';
  const content =
    readTrimmedString(value.content) ??
    readTrimmedString(value.text) ??
    readTrimmedString(value.message);

  if (!content) {
    return null;
  }

  const status = readTrimmedString(value.status);
  const normalizedStatus: RemoteConversationMessageStatus =
    status === 'sending' || status === 'sent' || status === 'received' || status === 'error'
      ? status
      : normalizedRole === 'user'
        ? 'sent'
        : 'received';

  return {
    id: readTrimmedString(value.id) ?? createMessageId(`remote-${normalizedRole}`),
    role: normalizedRole,
    content,
    createdAt: normalizeTimestamp(value.createdAt ?? value.timestamp),
    status: normalizedStatus,
    contextId:
      readTrimmedString(value.contextId) ??
      readTrimmedString(value.context_id),
    taskId:
      readTrimmedString(value.taskId) ??
      readTrimmedString(value.task_id),
    error: readTrimmedString(value.error),
  };
}

function normalizeConversationMessages(value: unknown): RemoteConversationMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeConversationMessage(entry))
    .filter((entry): entry is RemoteConversationMessage => entry != null);
}

function extractAssistantText(value: unknown): string | null {
  if (typeof value === 'string') {
    return readTrimmedString(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === 'string') {
          return readTrimmedString(entry);
        }
        if (isRecord(entry)) {
          return (
            readTrimmedString(entry.text) ??
            readTrimmedString(entry.content) ??
            readTrimmedString(entry.message)
          );
        }
        return null;
      })
      .filter((entry): entry is string => entry != null);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  return (
    readTrimmedString(value.text) ??
    readTrimmedString(value.content) ??
    readTrimmedString(value.message) ??
    extractAssistantText(value.parts) ??
    extractAssistantText(value.artifacts)
  );
}

function normalizeRemoteMessageResponse(value: unknown): {
  message: RemoteConversationMessage | null;
  messages: RemoteConversationMessage[];
  contextId: string | null;
  taskId: string | null;
} {
  if (!isRecord(value)) {
    return {
      message: null,
      messages: [],
      contextId: null,
      taskId: null,
    };
  }

  const conversation = isRecord(value.conversation) ? value.conversation : null;
  const runtime = isRecord(value.runtime) ? value.runtime : null;
  const contextId =
    readTrimmedString(value.contextId) ??
    readTrimmedString(value.context_id) ??
    readTrimmedString(value.context) ??
    readTrimmedString(conversation?.contextId) ??
    readTrimmedString(conversation?.context_id) ??
    readTrimmedString(runtime?.contextId) ??
    readTrimmedString(runtime?.context_id);
  const taskId =
    readTrimmedString(value.taskId) ??
    readTrimmedString(value.task_id) ??
    readTrimmedString(value.id) ??
    readTrimmedString(conversation?.taskId) ??
    readTrimmedString(conversation?.task_id) ??
    readTrimmedString(runtime?.taskId) ??
    readTrimmedString(runtime?.task_id);
  const directMessage =
    normalizeConversationMessage(value.message) ??
    normalizeConversationMessage(value.reply) ??
    normalizeConversationMessage(value.response) ??
    normalizeConversationMessage(value.result);
  const messages =
    normalizeConversationMessages(value.messages).length > 0
      ? normalizeConversationMessages(value.messages)
      : normalizeConversationMessages(value.parts).length > 0
        ? normalizeConversationMessages(value.parts)
        : normalizeConversationMessages(isRecord(value.result) ? value.result.messages : null);
  const assistantContent =
    extractAssistantText(value.text) ??
    extractAssistantText(value.content) ??
    extractAssistantText(value.reply) ??
    extractAssistantText(value.response) ??
    extractAssistantText(value.result) ??
    extractAssistantText(value.artifacts);

  const message =
    directMessage ??
    (assistantContent
      ? {
          id: createMessageId('remote-assistant'),
          role: 'assistant' as const,
          content: assistantContent,
          createdAt: new Date().toISOString(),
          status: 'received' as const,
          contextId,
          taskId,
          error: null,
        }
      : null);

  return {
    message,
    messages,
    contextId,
    taskId,
  };
}

function normalizeConversationThread(
  instanceId: string,
  value: unknown,
): RemoteInstanceConversationThread {
  if (!isRecord(value)) {
    return {
      instanceId,
      messages: [],
      contextId: null,
      taskId: null,
      updatedAt: null,
    };
  }

  return {
    instanceId,
    messages: normalizeConversationMessages(value.messages),
    contextId:
      readTrimmedString(value.contextId) ??
      readTrimmedString(value.context_id),
    taskId:
      readTrimmedString(value.taskId) ??
      readTrimmedString(value.task_id),
    updatedAt: readTrimmedString(value.updatedAt),
  };
}

function loadStoredThreads(): Record<string, RemoteInstanceConversationThread> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(REMOTE_CONVERSATIONS_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([instanceId, value]) => [
        instanceId,
        normalizeConversationThread(instanceId, value),
      ]),
    );
  } catch {
    return {};
  }
}

function saveStoredThreads(threadsByInstanceId: Record<string, RemoteInstanceConversationThread>): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(REMOTE_CONVERSATIONS_STORAGE_KEY, JSON.stringify(threadsByInstanceId));
  } catch {
    // Keep the in-memory transcript even if localStorage is unavailable.
  }
}

function getThread(
  threadsByInstanceId: Record<string, RemoteInstanceConversationThread>,
  instanceId: string,
): RemoteInstanceConversationThread {
  return threadsByInstanceId[instanceId] ?? {
    instanceId,
    messages: [],
    contextId: null,
    taskId: null,
    updatedAt: null,
  };
}

function mergeThread(
  threadsByInstanceId: Record<string, RemoteInstanceConversationThread>,
  instanceId: string,
  updater: (thread: RemoteInstanceConversationThread) => RemoteInstanceConversationThread,
): Record<string, RemoteInstanceConversationThread> {
  const nextThreads = {
    ...threadsByInstanceId,
    [instanceId]: updater(getThread(threadsByInstanceId, instanceId)),
  };
  saveStoredThreads(nextThreads);
  return nextThreads;
}

function inferAuthMode(
  explicitMode: unknown,
  bearerToken: string | null,
  headers: Record<string, string>,
): RemoteInstanceAuthMode {
  const normalizedMode = readTrimmedString(explicitMode);

  if (
    normalizedMode === 'none' ||
    normalizedMode === 'bearer' ||
    normalizedMode === 'headers' ||
    normalizedMode === 'mixed'
  ) {
    return normalizedMode;
  }

  const hasToken = bearerToken != null;
  const hasHeaders = Object.keys(headers).length > 0;

  if (hasToken && hasHeaders) {
    return 'mixed';
  }
  if (hasToken) {
    return 'bearer';
  }
  if (hasHeaders) {
    return 'headers';
  }
  return 'none';
}

function normalizeRemoteInstance(value: unknown): RemoteInstance | null {
  if (!isRecord(value)) {
    return null;
  }

  const auth = isRecord(value.auth) ? value.auth : null;
  const agentCard =
    normalizeAgentCard(value.agentCard) ??
    normalizeAgentCard(value.lastAgentCard) ??
    normalizeAgentCard(value.lastFetchedAgentCard) ??
    normalizeAgentCard(value.agentCardSnapshot);
  const headers = normalizeHeaders(value.headers ?? auth?.headers ?? value.customHeaders);
  const bearerToken =
    readTrimmedString(value.bearerToken) ??
    readTrimmedString(auth?.bearerToken) ??
    readTrimmedString(auth?.token);
  const id = readTrimmedString(value.id);
  const agentCardUrl =
    readTrimmedString(value.agentCardUrl) ??
    readTrimmedString(value.url) ??
    agentCard?.url;

  if (!id || !agentCardUrl) {
    return null;
  }

  return {
    id,
    displayName: readTrimmedString(value.displayName) ?? readTrimmedString(value.name),
    agentCardUrl,
    authMode: inferAuthMode(value.authMode ?? auth?.mode, bearerToken, headers),
    bearerToken,
    headers,
    agentCard,
    lastTest:
      normalizeTestResult(value.lastTest) ??
      normalizeTestResult(value.connectionTest) ??
      normalizeTestResult(value.health),
    createdAt: readTrimmedString(value.createdAt),
    updatedAt: readTrimmedString(value.updatedAt),
  };
}

function normalizeNullableString(value: unknown): string | null {
  return readTrimmedString(value);
}

function normalizeRemoteInstanceSelfApiKey(value: unknown): RemoteInstanceSelfApiKey | null {
  if (!isRecord(value)) {
    return null;
  }

  const label = readTrimmedString(value.label);
  if (!label) {
    return null;
  }

  return {
    label,
    maskedKey: readTrimmedString(value.maskedKey) ?? '********',
  };
}

function normalizeRemoteInstanceSelfAccessKey(value: unknown): RemoteInstanceSelfAccessKey | null {
  if (!isRecord(value)) {
    return null;
  }

  const label = readTrimmedString(value.label);
  const key = readTrimmedString(value.key);
  const header = readTrimmedString(value.header);

  if (!label || !key || !header) {
    return null;
  }

  return { label, key, header };
}

function normalizeRemoteInstanceSelf(value: unknown): RemoteInstanceSelf | null {
  if (!isRecord(value)) {
    return null;
  }

  const inbound = isRecord(value.inbound) ? value.inbound : {};
  const agentCard = isRecord(inbound.agentCard) ? inbound.agentCard : {};
  const urls = isRecord(value.urls) ? value.urls : {};
  const gateway = isRecord(value.gateway) ? value.gateway : {};
  const network = isRecord(value.network) ? value.network : {};
  const share = isRecord(value.share) ? value.share : {};
  const hints = isRecord(value.hints) ? value.hints : {};
  const apiKeys = Array.isArray(inbound.apiKeys)
    ? inbound.apiKeys
        .map((entry) => normalizeRemoteInstanceSelfApiKey(entry))
        .filter((entry): entry is RemoteInstanceSelfApiKey => entry != null)
    : [];

  return {
    enabled: value.enabled === true,
    gateway: {
      state: readTrimmedString(gateway.state),
      port: typeof gateway.port === 'number' && Number.isFinite(gateway.port) ? gateway.port : null,
    },
    network: {
      mode: network.mode === 'lan' ? 'lan' : 'local',
      bindMode: readTrimmedString(network.bindMode),
      tailscaleMode: readTrimmedString(network.tailscaleMode),
      customBindHost: readTrimmedString(network.customBindHost),
      externallyReachable: network.externallyReachable === true,
      requiresFirewall: network.requiresFirewall === true,
    },
    inbound: {
      agentCard: {
        name: normalizeNullableString(agentCard.name),
        description: normalizeNullableString(agentCard.description),
      },
      allowUnauthenticated: inbound.allowUnauthenticated === true,
      apiKeys,
    },
    urls: {
      localAgentCardUrl: normalizeNullableString(urls.localAgentCardUrl),
      localA2AEndpointUrl: normalizeNullableString(urls.localA2AEndpointUrl),
      lanAgentCardUrl: normalizeNullableString(urls.lanAgentCardUrl),
      lanA2AEndpointUrl: normalizeNullableString(urls.lanA2AEndpointUrl),
      tailscaleAgentCardUrlHint: normalizeNullableString(urls.tailscaleAgentCardUrlHint),
      tailscaleA2AEndpointUrlHint: normalizeNullableString(urls.tailscaleA2AEndpointUrlHint),
    },
    share: {
      url: normalizeNullableString(share.url),
      headerName: normalizeNullableString(share.headerName),
      headerValueExample: normalizeNullableString(share.headerValueExample),
      headerLineExample: normalizeNullableString(share.headerLineExample),
    },
    newAccessKey: normalizeRemoteInstanceSelfAccessKey(value.newAccessKey),
    hints: {
      lan: normalizeNullableString(hints.lan),
      tailscale: normalizeNullableString(hints.tailscale),
    },
    reloadRequested: value.reloadRequested === true,
  };
}

function normalizeRemoteInstances(values: unknown): RemoteInstance[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((entry) => normalizeRemoteInstance(entry))
    .filter((entry): entry is RemoteInstance => entry != null);
}

function chooseSelectedInstanceId(
  currentId: string | null,
  instances: RemoteInstance[],
): string | null {
  if (currentId && instances.some((instance) => instance.id === currentId)) {
    return currentId;
  }

  return instances[0]?.id ?? null;
}

function upsertInstance(instances: RemoteInstance[], nextInstance: RemoteInstance): RemoteInstance[] {
  const nextInstances = instances.filter((instance) => instance.id !== nextInstance.id);
  const previousIndex = instances.findIndex((instance) => instance.id === nextInstance.id);

  if (previousIndex < 0) {
    return [nextInstance, ...nextInstances];
  }

  nextInstances.splice(previousIndex, 0, nextInstance);
  return nextInstances;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setBusyFlag(
  busyById: Record<string, RemoteInstancesBusyState>,
  id: string,
  key: keyof RemoteInstancesBusyState,
  value: boolean,
): Record<string, RemoteInstancesBusyState> {
  const nextBusyById = { ...busyById };
  const currentState = { ...(nextBusyById[id] ?? {}) };

  if (value) {
    currentState[key] = true;
    nextBusyById[id] = currentState;
    return nextBusyById;
  }

  delete currentState[key];
  if (Object.keys(currentState).length === 0) {
    delete nextBusyById[id];
  } else {
    nextBusyById[id] = currentState;
  }

  return nextBusyById;
}

function requireRemoteInstance(value: unknown, context: string): RemoteInstance {
  const instance = normalizeRemoteInstance(value);
  if (!instance) {
    throw new Error(`Invalid remote instance response while ${context}`);
  }
  return instance;
}

function requireRemoteInstanceSelf(value: unknown, context: string): RemoteInstanceSelf {
  const self = normalizeRemoteInstanceSelf(value);
  if (!self) {
    throw new Error(`Invalid self remote instance response while ${context}`);
  }
  return self;
}

export const useRemoteInstancesStore = create<RemoteInstancesState>((set, get) => ({
  ...INITIAL_STATE,
  threadsByInstanceId: loadStoredThreads(),

  clearError: () => set({ error: null }),

  reset: () => {
    saveStoredThreads({});
    set({ ...INITIAL_STATE, threadsByInstanceId: {} });
  },

  selectInstance: (id) => set({ selectedInstanceId: id }),

  clearSelfNewAccessKey: () => set((state) => ({
    self: state.self
      ? {
          ...state.self,
          newAccessKey: null,
        }
      : null,
  })),

  fetchSelf: async (options) => {
    if (get().selfLoading) {
      return;
    }

    if (get().selfLoaded && !options?.force) {
      return;
    }

    set({ selfLoading: true, error: null });

    try {
      const response = await hostApiFetch<{ self?: unknown }>('/api/remote-instances/self');
      const self = requireRemoteInstanceSelf(response?.self, 'loading self inbound A2A settings');
      set({
        self,
        selfLoading: false,
        selfLoaded: true,
      });
    } catch (error) {
      set({
        selfLoading: false,
        selfLoaded: true,
        error: toErrorMessage(error),
      });
    }
  },

  updateSelf: async (input) => {
    set({ selfSaving: true, error: null });

    try {
      const response = await hostApiFetch<{ self?: unknown }>('/api/remote-instances/self', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      const self = requireRemoteInstanceSelf(response?.self, 'saving self inbound A2A settings');
      set({
        self,
        selfSaving: false,
        selfLoaded: true,
      });
      return self;
    } catch (error) {
      const message = toErrorMessage(error);
      set({ selfSaving: false, error: message });
      throw error;
    }
  },

  generateSelfAccessKey: async (label) => {
    set({ selfGeneratingKey: true, error: null });

    try {
      const response = await hostApiFetch<{ self?: unknown }>('/api/remote-instances/self/api-keys', {
        method: 'POST',
        body: JSON.stringify({ label }),
      });
      const self = requireRemoteInstanceSelf(response?.self, 'generating self inbound A2A access key');
      const accessKey = self.newAccessKey;
      if (!accessKey) {
        throw new Error('Host did not return the generated access key');
      }
      set({
        self,
        selfGeneratingKey: false,
        selfLoaded: true,
      });
      return accessKey;
    } catch (error) {
      const message = toErrorMessage(error);
      set({ selfGeneratingKey: false, error: message });
      throw error;
    }
  },

  revokeSelfAccessKey: async (label) => {
    set((state) => ({
      error: null,
      selfRevokingKeyByLabel: {
        ...state.selfRevokingKeyByLabel,
        [label]: true,
      },
    }));

    try {
      const response = await hostApiFetch<{ self?: unknown }>(
        `/api/remote-instances/self/api-keys/${encodeURIComponent(label)}`,
        {
          method: 'DELETE',
        },
      );
      const self = requireRemoteInstanceSelf(response?.self, 'revoking self inbound A2A access key');
      set((state) => {
        const nextRevoking = { ...state.selfRevokingKeyByLabel };
        delete nextRevoking[label];
        return {
          self,
          selfLoaded: true,
          selfRevokingKeyByLabel: nextRevoking,
        };
      });
    } catch (error) {
      const message = toErrorMessage(error);
      set((state) => {
        const nextRevoking = { ...state.selfRevokingKeyByLabel };
        delete nextRevoking[label];
        return {
          error: message,
          selfRevokingKeyByLabel: nextRevoking,
        };
      });
      throw error;
    }
  },

  fetchInstances: async (options) => {
    if (get().loading) {
      return;
    }

    if (get().loaded && !options?.force) {
      return;
    }

    set({ loading: true, error: null });

    try {
      const response = await hostApiFetch<{ instances?: unknown[] }>('/api/remote-instances');
      const instances = normalizeRemoteInstances(response?.instances);

      set((state) => ({
        instances,
        selectedInstanceId: chooseSelectedInstanceId(state.selectedInstanceId, instances),
        loading: false,
        loaded: true,
      }));
    } catch (error) {
      set({
        loading: false,
        loaded: true,
        error: toErrorMessage(error),
      });
    }
  },

  createInstance: async (input) => {
    set({ creating: true, error: null });

    try {
      const response = await hostApiFetch<{ instance?: unknown }>('/api/remote-instances', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      const instance = requireRemoteInstance(response?.instance, 'creating remote instance');

      set((state) => {
        const instances = upsertInstance(state.instances, instance);
        return {
          instances,
          selectedInstanceId: instance.id,
          creating: false,
          loaded: true,
        };
      });

      return instance;
    } catch (error) {
      const message = toErrorMessage(error);
      set({ creating: false, error: message });
      throw error;
    }
  },

  updateInstance: async (id, input) => {
    set((state) => ({
      error: null,
      busyById: setBusyFlag(state.busyById, id, 'saving', true),
    }));

    try {
      const response = await hostApiFetch<{ instance?: unknown }>(
        `/api/remote-instances/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(input),
        },
      );
      const instance = requireRemoteInstance(response?.instance, 'updating remote instance');

      set((state) => ({
        instances: upsertInstance(state.instances, instance),
        selectedInstanceId: state.selectedInstanceId ?? instance.id,
        busyById: setBusyFlag(state.busyById, id, 'saving', false),
      }));

      return instance;
    } catch (error) {
      const message = toErrorMessage(error);
      set((state) => ({
        error: message,
        busyById: setBusyFlag(state.busyById, id, 'saving', false),
      }));
      throw error;
    }
  },

  deleteInstance: async (id) => {
    set((state) => ({
      error: null,
      busyById: setBusyFlag(state.busyById, id, 'deleting', true),
    }));

    try {
      await hostApiFetch(`/api/remote-instances/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });

      set((state) => {
        const instances = state.instances.filter((instance) => instance.id !== id);
        return {
          instances,
          selectedInstanceId: chooseSelectedInstanceId(state.selectedInstanceId, instances),
          busyById: setBusyFlag(state.busyById, id, 'deleting', false),
        };
      });
    } catch (error) {
      const message = toErrorMessage(error);
      set((state) => ({
        error: message,
        busyById: setBusyFlag(state.busyById, id, 'deleting', false),
      }));
      throw error;
    }
  },

  refreshAgentCard: async (id) => {
    set((state) => ({
      error: null,
      busyById: setBusyFlag(state.busyById, id, 'refreshing', true),
    }));

    try {
      const response = await hostApiFetch<{ instance?: unknown; agentCard?: unknown }>(
        `/api/remote-instances/${encodeURIComponent(id)}/agent-card/refresh`,
        {
          method: 'POST',
        },
      );

      const existingInstance = get().instances.find((instance) => instance.id === id);
      const instance =
        normalizeRemoteInstance(response?.instance) ??
        (existingInstance
          ? {
              ...existingInstance,
              agentCard: normalizeAgentCard(response?.agentCard) ?? existingInstance.agentCard,
            }
          : null);

      if (!instance) {
        throw new Error('Invalid remote instance response while refreshing Agent Card');
      }

      set((state) => ({
        instances: upsertInstance(state.instances, instance),
        selectedInstanceId: state.selectedInstanceId ?? instance.id,
        busyById: setBusyFlag(state.busyById, id, 'refreshing', false),
      }));

      return instance;
    } catch (error) {
      const message = toErrorMessage(error);
      set((state) => ({
        error: message,
        busyById: setBusyFlag(state.busyById, id, 'refreshing', false),
      }));
      throw error;
    }
  },

  sendRemoteMessage: async (id, input) => {
    const text = input.message.trim();
    if (!text) {
      return null;
    }

    const now = new Date().toISOString();
    const existingThread = getThread(get().threadsByInstanceId, id);
    const userMessage: RemoteConversationMessage = {
      id: createMessageId('remote-user'),
      role: 'user',
      content: text,
      createdAt: now,
      status: 'sending',
      contextId: existingThread.contextId,
      taskId: existingThread.taskId,
      error: null,
    };

    set((state) => ({
      error: null,
      threadsByInstanceId: mergeThread(state.threadsByInstanceId, id, (thread) => ({
        ...thread,
        messages: [...thread.messages, userMessage],
        updatedAt: now,
      })),
      busyById: setBusyFlag(state.busyById, id, 'sending', true),
    }));

    try {
      const response = await hostApiFetch<Record<string, unknown>>(
        `/api/remote-instances/${encodeURIComponent(id)}/conversation/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            message: text,
            contextId: existingThread.contextId,
            context_id: existingThread.contextId,
          }),
        },
      );
      const normalized = normalizeRemoteMessageResponse(response);
      const nextContextId = normalized.contextId ?? existingThread.contextId;
      const nextTaskId = normalized.taskId ?? existingThread.taskId;
      const assistantMessages = [
        ...normalized.messages,
        ...(normalized.message ? [normalized.message] : []),
      ].map((message) => ({
        ...message,
        contextId: message.contextId ?? nextContextId,
        taskId: message.taskId ?? nextTaskId,
      }));

      set((state) => ({
        threadsByInstanceId: mergeThread(state.threadsByInstanceId, id, (thread) => ({
          ...thread,
          messages: [
            ...thread.messages.map((message) =>
              message.id === userMessage.id
                ? {
                    ...message,
                    status: 'sent' as const,
                    contextId: nextContextId,
                    taskId: nextTaskId,
                  }
                : message,
            ),
            ...assistantMessages,
          ],
          contextId: nextContextId,
          taskId: nextTaskId,
          updatedAt: new Date().toISOString(),
        })),
        busyById: setBusyFlag(state.busyById, id, 'sending', false),
      }));

      return normalized.message ?? assistantMessages[0] ?? null;
    } catch (error) {
      const message = toErrorMessage(error);
      set((state) => ({
        error: message,
        threadsByInstanceId: mergeThread(state.threadsByInstanceId, id, (thread) => ({
          ...thread,
          messages: thread.messages.map((entry) =>
            entry.id === userMessage.id
              ? {
                  ...entry,
                  status: 'error' as const,
                  error: message,
                }
              : entry,
          ),
          updatedAt: new Date().toISOString(),
        })),
        busyById: setBusyFlag(state.busyById, id, 'sending', false),
      }));
      throw error;
    }
  },

  testConnection: async (id) => {
    set((state) => ({
      error: null,
      busyById: setBusyFlag(state.busyById, id, 'testing', true),
    }));

    try {
      const response = await hostApiFetch<Record<string, unknown>>(
        `/api/remote-instances/${encodeURIComponent(id)}/test`,
        {
          method: 'POST',
        },
      );
      const nextTest = normalizeTestResult(response);

      if (!nextTest) {
        throw new Error('Invalid connection test response');
      }

      set((state) => ({
        instances: state.instances.map((instance) =>
          instance.id === id
            ? {
                ...instance,
                lastTest: nextTest,
              }
            : instance,
        ),
        busyById: setBusyFlag(state.busyById, id, 'testing', false),
      }));

      return nextTest;
    } catch (error) {
      const message = toErrorMessage(error);
      set((state) => ({
        error: message,
        busyById: setBusyFlag(state.busyById, id, 'testing', false),
      }));
      throw error;
    }
  },
}));
