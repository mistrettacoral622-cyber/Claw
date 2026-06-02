import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock, hostApiFetchMock, agentsState, settingsState, providerStoreState } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
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

describe('chat target routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T12:00:00Z'));
    window.localStorage.clear();

    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
        chatAccess: 'direct',
        reportsTo: null,
      },
      {
        id: 'research',
        name: 'Research',
        isDefault: false,
        modelDisplay: 'Claude',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace-research',
        agentDir: '~/.openclaw/agents/research/agent',
        mainSessionKey: 'agent:research:desk',
        channelTypes: [],
        chatAccess: 'direct',
        reportsTo: 'main',
      },
    ];
    settingsState.defaultModel = 'claude-sonnet-4-6';
    providerStoreState.accounts = [];
    providerStoreState.vendors = [];
    providerStoreState.defaultAccountId = null;

    gatewayRpcMock.mockReset();
    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'chat.send') {
        return { runId: 'run-text' };
      }
      if (method === 'chat.abort') {
        return { ok: true };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/sessions/recovered-history')) {
        return { messages: [] };
      }
      if (path === '/api/chat/send-with-media') {
        return { success: true, result: { runId: 'run-media' } };
      }
      throw new Error(`Unexpected host API call: ${path}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('switches to the selected agent private session before sending text', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'assistant', content: 'Existing main history' }],
      sessionLabels: {},
      sessionLastActivity: {},
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
    });

    await useChatStore.getState().sendMessage('Hello direct agent', undefined, 'research', '/tmp/workspace');

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:research:private-research');
    expect(state.currentAgentId).toBe('research');
    expect(state.sessions.some((session) => session.key === 'agent:research:private-research')).toBe(true);
    expect(state.sessions.find((session) => session.key === 'agent:research:private-research')).toMatchObject({
      agentId: 'research',
      targetAgentId: 'research',
      isPrivateChat: true,
    });
    expect(state.messages.at(-1)?.content).toBe('Hello direct agent');

    const historyCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.history');
    expect(historyCall?.[1]).toEqual({ sessionKey: 'agent:research:desk', limit: 200 });

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect(sendCall?.[1]).toMatchObject({
      sessionKey: 'agent:research:desk',
      message: 'Hello direct agent',
      deliver: false,
      cwd: '/tmp/workspace',
    });
    expect(typeof (sendCall?.[1] as { idempotencyKey?: unknown })?.idempotencyKey).toBe('string');
  });

  it('uses the selected agent private session for attachment sends while keeping the effective backend session', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
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
    });

    await useChatStore.getState().sendMessage(
      '',
      [
        {
          fileName: 'design.png',
          mimeType: 'image/png',
          fileSize: 128,
          stagedPath: '/tmp/design.png',
          preview: 'data:image/png;base64,abc',
        },
      ],
      'research',
      '/tmp/workspace-media',
    );

    expect(useChatStore.getState().currentSessionKey).toBe('agent:research:private-research');

    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/chat/send-with-media',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );

    const mediaCall = hostApiFetchMock.mock.calls.find(([path]) => path === '/api/chat/send-with-media');
    expect(mediaCall).toBeTruthy();
    const payload = JSON.parse(
      (mediaCall?.[1] as { body: string }).body,
    ) as {
      sessionKey: string;
      message: string;
      cwd?: string;
      media: Array<{ filePath: string }>;
    };

    expect(payload.sessionKey).toBe('agent:research:desk');
    expect(payload.message).toContain('Process the attached file(s).');
    expect(payload.message).not.toContain('/tmp/design.png');
    expect(payload.cwd).toBe('/tmp/workspace-media');
    expect(payload.media[0]?.filePath).toBe('/tmp/design.png');
  });

  it('maps image capability failures to a friendly Chinese message', async () => {
    const { useChatStore } = await import('@/stores/chat');

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/sessions/recovered-history')) {
        return { messages: [] };
      }
      if (path === '/api/chat/send-with-media') {
        return {
          success: false,
          error: 'This model does not support image_url inputs',
        };
      }
      throw new Error(`Unexpected host API call: ${path}`);
    });

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
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
    });

    await useChatStore.getState().sendMessage(
      '',
      [
        {
          fileName: 'design.png',
          mimeType: 'image/png',
          fileSize: 128,
          stagedPath: '/tmp/design.png',
          preview: 'data:image/png;base64,abc',
        },
      ],
      'research',
      '/tmp/workspace-media',
    );

    expect(useChatStore.getState().error).toBe('该模型暂时不能识别图片哦。');
  });

  it('maps image network failures to an actionable Chinese message', async () => {
    const { useChatStore } = await import('@/stores/chat');

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/sessions/recovered-history')) {
        return { messages: [] };
      }
      if (path === '/api/chat/send-with-media') {
        return {
          success: false,
          error: 'LLM request failed: network connection error.',
        };
      }
      throw new Error(`Unexpected host API call: ${path}`);
    });

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
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
    });

    await useChatStore.getState().sendMessage(
      '',
      [
        {
          fileName: 'design.png',
          mimeType: 'image/png',
          fileSize: 128,
          stagedPath: '/tmp/design.png',
          preview: 'data:image/png;base64,abc',
        },
      ],
      'research',
      '/tmp/workspace-media',
    );

    expect(useChatStore.getState().error).toBe('拍照识别失败：当前图片识别请求的网络或 Provider 连接不可用。请检查视觉模型、API Key、代理或网络连接后重试。');
  });

  it('rejects leader-only workers as direct target agents before switching sessions', async () => {
    agentsState.agents[1] = {
      ...agentsState.agents[1],
      chatAccess: 'leader_only',
    };

    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
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
    });

    await expect(
      useChatStore.getState().sendMessage('Blocked direct worker', undefined, 'research', null),
    ).rejects.toThrow();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:main');
    expect(gatewayRpcMock).not.toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({ sessionKey: 'agent:research:desk' }),
    );
  });

  it('short-circuits image sends for text-only models with a friendly assistant reply', async () => {
    const { useChatStore } = await import('@/stores/chat');
    settingsState.defaultModel = 'qwen3.5-0.8b';

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
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
    });

    await useChatStore.getState().sendMessage(
      '',
      [
        {
          fileName: 'design.png',
          mimeType: 'image/png',
          fileSize: 128,
          stagedPath: '/tmp/design.png',
          preview: 'data:image/png;base64,abc',
        },
      ],
      'research',
      '/tmp/workspace-media',
    );

    expect(hostApiFetchMock.mock.calls.some(([path]) => path === '/api/chat/send-with-media')).toBe(false);
    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.error).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '该模型暂时不能识别图片哦。',
    });
  });
});
