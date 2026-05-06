import { beforeEach, describe, expect, it, vi } from 'vitest';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const {
  gatewayRpcMock,
  hostApiFetchMock,
  agentsState,
  settingsState,
  providerStoreState,
} = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
    agentStatuses: {} as Record<string, 'online' | 'offline' | 'busy'>,
  },
  settingsState: {
    defaultModel: 'claude-sonnet-4-6',
  },
  providerStoreState: {
    accounts: [] as Array<Record<string, unknown>>,
    vendors: [] as Array<Record<string, unknown>>,
    defaultAccountId: null as string | null,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: gatewayRpcMock,
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
  },
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => settingsState,
  },
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: {
    getState: () => providerStoreState,
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

const baseChatState = {
  currentSessionKey: 'agent:main:session-a',
  currentAgentId: 'main',
  sessions: [
    { key: 'agent:main:session-a', displayName: 'Session A' },
    { key: 'agent:main:session-b', displayName: 'Session B' },
  ],
  messages: [],
  sessionLabels: {},
  sessionLastActivity: {},
  sessionUnreadCounts: {},
  sending: false,
  activeRunId: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingFinal: false,
  lastUserMessageAt: null,
  pendingToolImages: [],
  error: null,
  loading: false,
  thinkingLevel: null,
  showThinking: true,
  composerDraft: '',
};

async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('chat history race handling', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();

    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'Claude',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
        chatAccess: 'direct',
        reportsTo: null,
      },
    ];
    agentsState.agentStatuses = { main: 'online' };
    settingsState.defaultModel = 'claude-sonnet-4-6';
    providerStoreState.accounts = [];
    providerStoreState.vendors = [];
    providerStoreState.defaultAccountId = null;
    gatewayRpcMock.mockReset();
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({});
  });

  it('ignores stale history results from a previous session after switching', async () => {
    const sessionAHistory = createDeferred<Record<string, unknown>>();
    const sessionBHistory = createDeferred<Record<string, unknown>>();

    gatewayRpcMock.mockImplementation((method: string, payload: Record<string, unknown>) => {
      if (method === 'chat.history') {
        const sessionKey = payload.sessionKey;
        if (sessionKey === 'agent:main:session-a') {
          return sessionAHistory.promise;
        }
        if (sessionKey === 'agent:main:session-b') {
          return sessionBHistory.promise;
        }
      }
      if (method === 'chat.abort') {
        return { ok: true };
      }
      if (method === 'chat.send') {
        return { runId: 'run-test' };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState(baseChatState);

    const staleLoad = useChatStore.getState().loadHistory();
    useChatStore.getState().switchSession('agent:main:session-b');
    await flushMicrotasks();

    sessionBHistory.resolve({
      messages: [
        { id: 'b-1', role: 'assistant', content: 'B history', timestamp: 2 },
      ],
    });
    await flushMicrotasks();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:session-b');
    expect(useChatStore.getState().messages.some((message) => message.content === 'B history')).toBe(true);

    sessionAHistory.resolve({
      messages: [
        { id: 'a-1', role: 'assistant', content: 'A history', timestamp: 1 },
      ],
    });
    await staleLoad;
    await flushMicrotasks();

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:main:session-b');
    expect(state.messages.some((message) => message.content === 'A history')).toBe(false);
    expect(state.messages.some((message) => message.content === 'B history')).toBe(true);
  });

  it('ignores stale thumbnail refreshes from a previous session after switching', async () => {
    const sessionAThumbs = createDeferred<Record<string, { preview: string | null; fileSize: number }>>();

    gatewayRpcMock.mockImplementation((method: string, payload: Record<string, unknown>) => {
      if (method === 'chat.history') {
        if (payload.sessionKey === 'agent:main:session-a') {
          return {
            messages: [
              {
                id: 'a-user',
                role: 'user',
                content: '[media attached: /tmp/a.png (image/png) | /tmp/a.png]',
                timestamp: 1,
              },
            ],
          };
        }
        if (payload.sessionKey === 'agent:main:session-b') {
          return {
            messages: [
              { id: 'b-1', role: 'assistant', content: 'B history', timestamp: 2 },
            ],
          };
        }
      }
      if (method === 'chat.abort') {
        return { ok: true };
      }
      if (method === 'chat.send') {
        return { runId: 'run-test' };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/files/thumbnails') {
        return sessionAThumbs.promise;
      }
      throw new Error(`Unexpected host API call: ${path}`);
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState(baseChatState);

    await useChatStore.getState().loadHistory();
    expect(useChatStore.getState().messages.some((message) => message.id === 'a-user')).toBe(true);

    useChatStore.getState().switchSession('agent:main:session-b');
    await flushMicrotasks();
    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:session-b');
    expect(useChatStore.getState().messages.some((message) => message.content === 'B history')).toBe(true);

    sessionAThumbs.resolve({
      '/tmp/a.png': {
        preview: 'data:image/png;base64,abc',
        fileSize: 128,
      },
    });
    await flushMicrotasks();

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:main:session-b');
    expect(state.messages.some((message) => message.content === 'B history')).toBe(true);
    expect(state.messages.some((message) => message.id === 'a-user')).toBe(false);
  });

  it('keeps optimistic image attachment metadata when gateway history omits local image refs', async () => {
    const userTimestampMs = Date.now();
    const attachedFile = {
      fileName: 'design.png',
      mimeType: 'image/png',
      fileSize: 128,
      preview: 'data:image/png;base64,abc',
      filePath: '/tmp/design.png',
    };

    gatewayRpcMock.mockImplementation((method: string, payload: Record<string, unknown>) => {
      if (method === 'chat.history') {
        expect(payload.sessionKey).toBe('agent:main:session-a');
        return {
          messages: [
            {
              id: 'gateway-user',
              role: 'user',
              content: 'Process the attached file(s).',
              timestamp: userTimestampMs / 1000,
            },
            {
              id: 'gateway-assistant',
              role: 'assistant',
              content: 'I can see the image.',
              timestamp: (userTimestampMs + 2000) / 1000,
            },
          ],
        };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      ...baseChatState,
      messages: [
        {
          id: 'optimistic-user',
          role: 'user',
          content: '(file attached)',
          timestamp: userTimestampMs / 1000,
          _attachedFiles: [attachedFile],
        },
      ],
      sending: true,
      lastUserMessageAt: userTimestampMs,
      pendingFinal: true,
    });

    await useChatStore.getState().loadHistory();

    const state = useChatStore.getState();
    const gatewayUser = state.messages.find((message) => message.id === 'gateway-user');
    expect(gatewayUser?._attachedFiles).toEqual([attachedFile]);
    expect(state.messages.some((message) => message.id === 'optimistic-user')).toBe(false);
  });

  it('drops ghost file attachments when thumbnail recovery proves the file does not exist', async () => {
    gatewayRpcMock.mockImplementation((method: string, payload: Record<string, unknown>) => {
      if (method === 'chat.history') {
        expect(payload.sessionKey).toBe('agent:main:session-a');
        return {
          messages: [
            {
              id: 'assistant-ghost',
              role: 'assistant',
              content: 'Found image at C:\\Users\\me\\Downloads\\ChatGPT Image 2026��4��29�� 01_27_00.png',
              timestamp: 1,
            },
          ],
        };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/files/thumbnails') {
        return {
          'C:\\Users\\me\\Downloads\\ChatGPT Image 2026��4��29�� 01_27_00.png': {
            preview: null,
            fileSize: 0,
          },
        };
      }
      throw new Error(`Unexpected host API call: ${path}`);
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState(baseChatState);

    await useChatStore.getState().loadHistory();
    await flushMicrotasks();

    const state = useChatStore.getState();
    const ghostMessage = state.messages.find((message) => message.id === 'assistant-ghost');
    expect(ghostMessage?._attachedFiles ?? []).toEqual([]);
  });
});
