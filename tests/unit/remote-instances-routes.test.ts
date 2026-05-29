import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();

const listRemoteInstancesMock = vi.fn();
const getRemoteInstanceMock = vi.fn();
const createRemoteInstanceMock = vi.fn();
const updateRemoteInstanceMock = vi.fn();
const deleteRemoteInstanceMock = vi.fn();

const fetchAgentCardMock = vi.fn();
const syncRemoteInstancesToA2APluginMock = vi.fn();
const testRemoteInstanceConnectionMock = vi.fn();
const sendRemoteInstanceMessageMock = vi.fn();
const getRemoteInstanceTaskMock = vi.fn();
const getA2APluginConfigFromOpenClawMock = vi.fn();
const getGatewayExposureConfigFromOpenClawMock = vi.fn();
const updateA2AInboundConfigInOpenClawMock = vi.fn();
const updateGatewayExposureConfigInOpenClawMock = vi.fn();
const generateA2AInboundApiKeyInOpenClawMock = vi.fn();
const revokeA2AInboundApiKeyInOpenClawMock = vi.fn();

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/services/remote-instances/config', () => ({
  listRemoteInstances: (...args: unknown[]) => listRemoteInstancesMock(...args),
  getRemoteInstance: (...args: unknown[]) => getRemoteInstanceMock(...args),
  createRemoteInstance: (...args: unknown[]) => createRemoteInstanceMock(...args),
  updateRemoteInstance: (...args: unknown[]) => updateRemoteInstanceMock(...args),
  deleteRemoteInstance: (...args: unknown[]) => deleteRemoteInstanceMock(...args),
}));

vi.mock('@electron/services/remote-instances/agent-card', () => ({
  fetchAgentCard: (...args: unknown[]) => fetchAgentCardMock(...args),
}));

vi.mock('@electron/services/remote-instances/a2a-runtime', () => ({
  getRemoteInstanceTask: (...args: unknown[]) => getRemoteInstanceTaskMock(...args),
  sendRemoteInstanceMessage: (...args: unknown[]) => sendRemoteInstanceMessageMock(...args),
  syncRemoteInstancesToA2APlugin: (...args: unknown[]) => syncRemoteInstancesToA2APluginMock(...args),
  testRemoteInstanceConnection: (...args: unknown[]) => testRemoteInstanceConnectionMock(...args),
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  getA2APluginConfigFromOpenClaw: (...args: unknown[]) => getA2APluginConfigFromOpenClawMock(...args),
  getGatewayExposureConfigFromOpenClaw: (...args: unknown[]) => getGatewayExposureConfigFromOpenClawMock(...args),
  updateA2AInboundConfigInOpenClaw: (...args: unknown[]) => updateA2AInboundConfigInOpenClawMock(...args),
  updateGatewayExposureConfigInOpenClaw: (...args: unknown[]) => updateGatewayExposureConfigInOpenClawMock(...args),
  generateA2AInboundApiKeyInOpenClaw: (...args: unknown[]) => generateA2AInboundApiKeyInOpenClawMock(...args),
  revokeA2AInboundApiKeyInOpenClaw: (...args: unknown[]) => revokeA2AInboundApiKeyInOpenClawMock(...args),
}));

function createCtx(port = 18789) {
  return {
    gatewayManager: {
      getStatus: () => ({ state: 'running', port }),
      debouncedReload: vi.fn(),
      debouncedRestart: vi.fn(),
    },
  } as never;
}

describe('remote instance routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listRemoteInstancesMock.mockResolvedValue([]);
    syncRemoteInstancesToA2APluginMock.mockResolvedValue(undefined);
    getA2APluginConfigFromOpenClawMock.mockResolvedValue({
      enabled: false,
      inbound: {},
      outbound: { agents: {} },
    });
    getGatewayExposureConfigFromOpenClawMock.mockResolvedValue({
      bindMode: 'loopback',
      tailscaleMode: 'off',
    });
    updateGatewayExposureConfigInOpenClawMock.mockResolvedValue({
      bindMode: 'lan',
      tailscaleMode: 'off',
    });
  });

  it('lists remote instances through the host route family', async () => {
    listRemoteInstancesMock.mockResolvedValue([{ id: 'ri-1' }]);
    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      items: [{ id: 'ri-1' }],
      instances: [{ id: 'ri-1' }],
    });
  });

  it('creates a remote instance from an Agent Card URL and syncs runtime config in main', async () => {
    parseJsonBodyMock.mockResolvedValue({
      agentCardUrl: 'https://remote.example/.well-known/agent-card.json',
      auth: {
        mode: 'bearer',
        token: 'abc123',
      },
    });
    fetchAgentCardMock.mockResolvedValue({
      agentCard: {
        name: 'Remote Agent',
        description: 'Agent',
        url: 'https://remote.example/.well-known/agent-card.json',
        capabilities: [],
        defaultInputModes: [],
        defaultOutputModes: [],
        skills: [],
        raw: {},
        fetchedAt: '2026-05-20T00:00:00.000Z',
      },
      latencyMs: 42,
      httpStatus: 200,
    });
    createRemoteInstanceMock.mockResolvedValue({
      id: 'ri-1',
      displayName: 'Remote Agent',
    });
    listRemoteInstancesMock.mockResolvedValue([{ id: 'ri-1', agentCardUrl: 'https://remote.example/.well-known/agent-card.json' }]);

    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(fetchAgentCardMock).toHaveBeenCalledWith({
      url: 'https://remote.example/.well-known/agent-card.json',
      auth: {
        mode: 'bearer',
        token: 'abc123',
        headers: undefined,
      },
    });
    expect(syncRemoteInstancesToA2APluginMock).toHaveBeenCalledWith([
      { id: 'ri-1', agentCardUrl: 'https://remote.example/.well-known/agent-card.json' },
    ]);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 201, {
      success: true,
      instance: {
        id: 'ri-1',
        displayName: 'Remote Agent',
      },
    });
  });

  it('returns self inbound A2A URLs and masked access keys before generic id routes', async () => {
    getA2APluginConfigFromOpenClawMock.mockResolvedValue({
      enabled: true,
      inbound: {
        allowUnauthenticated: false,
        agentCard: {
          name: 'My KTClaw',
          description: 'Desktop agent',
        },
        apiKeys: [
          { label: 'alice', key: 'ktclaw_a2a_abcdefghijklmnopqrstuvwxyz' },
        ],
      },
      outbound: { agents: {} },
    });
    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/self'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(getRemoteInstanceMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      self: expect.objectContaining({
        enabled: true,
        network: expect.objectContaining({
          mode: 'local',
          bindMode: 'loopback',
        }),
        urls: expect.objectContaining({
          localAgentCardUrl: 'http://127.0.0.1:18789/.well-known/agent-card.json',
          localA2AEndpointUrl: 'http://127.0.0.1:18789/a2a',
        }),
        inbound: expect.objectContaining({
          agentCard: expect.objectContaining({ name: 'My KTClaw' }),
          apiKeys: [
            { label: 'alice', maskedKey: 'ktclaw_a...wxyz' },
          ],
        }),
      }),
    }));
  });

  it('builds remote self URLs from the configured gateway port', async () => {
    getA2APluginConfigFromOpenClawMock.mockResolvedValue({
      enabled: true,
      inbound: {
        agentCard: {
          name: 'My KTClaw',
        },
      },
      outbound: { agents: {} },
    });
    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/self'),
      createCtx(24567),
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      self: expect.objectContaining({
        gateway: expect.objectContaining({
          port: 24567,
        }),
        urls: expect.objectContaining({
          localAgentCardUrl: 'http://127.0.0.1:24567/.well-known/agent-card.json',
          localA2AEndpointUrl: 'http://127.0.0.1:24567/a2a',
        }),
      }),
    }));
  });

  it('prefers real private LAN IPv4 addresses over virtual benchmark adapters', async () => {
    const { selectBestLanIpv4Address } = await import('@electron/api/routes/remote-instances');

    expect(selectBestLanIpv4Address({
      Meta: [{
        address: '198.18.0.1',
        family: 'IPv4',
        internal: false,
      }],
      WLAN: [{
        address: '10.101.208.208',
        family: 'IPv4',
        internal: false,
      }],
    } as never)).toBe('10.101.208.208');
  });

  it('uses a Tailscale IPv4 address when no private LAN address is available', async () => {
    const { selectBestLanIpv4Address } = await import('@electron/api/routes/remote-instances');

    expect(selectBestLanIpv4Address({
      Meta: [{
        address: '198.18.0.1',
        family: 'IPv4',
        internal: false,
      }],
      Tailscale: [{
        address: '100.99.88.77',
        family: 'IPv4',
        internal: false,
      }],
    } as never)).toBe('100.99.88.77');
  });

  it('updates self inbound A2A settings and restarts the Gateway when network bind changes', async () => {
    parseJsonBodyMock.mockResolvedValue({
      enabled: true,
      agentCardName: 'Shared Desktop',
      agentCardDescription: 'Remote-controlled KTClaw',
      allowUnauthenticated: false,
      networkMode: 'lan',
    });
    updateA2AInboundConfigInOpenClawMock.mockResolvedValue({
      enabled: true,
      inbound: {
        allowUnauthenticated: false,
        agentCard: {
          name: 'Shared Desktop',
          description: 'Remote-controlled KTClaw',
        },
      },
      outbound: { agents: {} },
    });
    const ctx = createCtx() as {
      gatewayManager: {
        debouncedReload: ReturnType<typeof vi.fn>;
        debouncedRestart: ReturnType<typeof vi.fn>;
      };
    };
    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'PATCH' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/self'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(updateRemoteInstanceMock).not.toHaveBeenCalled();
    expect(updateA2AInboundConfigInOpenClawMock).toHaveBeenCalledWith({
      enabled: true,
      agentCard: {
        name: 'Shared Desktop',
        description: 'Remote-controlled KTClaw',
      },
      allowUnauthenticated: false,
    });
    expect(updateGatewayExposureConfigInOpenClawMock).toHaveBeenCalledWith({
      bindMode: 'lan',
    });
    expect(ctx.gatewayManager.debouncedRestart).toHaveBeenCalledWith(500);
    expect(ctx.gatewayManager.debouncedReload).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      self: expect.objectContaining({
        network: expect.objectContaining({
          mode: 'lan',
          bindMode: 'lan',
        }),
        reloadRequested: true,
      }),
    }));
  });

  it('generates a self inbound access key and returns the raw header once', async () => {
    parseJsonBodyMock.mockResolvedValue({ label: 'teammate' });
    generateA2AInboundApiKeyInOpenClawMock.mockResolvedValue({
      snapshot: {
        enabled: true,
        inbound: {
          apiKeys: [
            { label: 'teammate', key: 'ktclaw_a2a_secret' },
          ],
        },
        outbound: { agents: {} },
      },
      apiKey: {
        label: 'teammate',
        key: 'ktclaw_a2a_secret',
      },
    });
    const ctx = createCtx() as {
      gatewayManager: {
        debouncedRestart: ReturnType<typeof vi.fn>;
      };
    };
    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/self/api-keys'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(generateA2AInboundApiKeyInOpenClawMock).toHaveBeenCalledWith('teammate');
    expect(ctx.gatewayManager.debouncedRestart).toHaveBeenCalledWith(500);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 201, expect.objectContaining({
      self: expect.objectContaining({
        newAccessKey: {
          label: 'teammate',
          key: 'ktclaw_a2a_secret',
          header: 'Authorization: Bearer ktclaw_a2a_secret',
        },
        share: expect.objectContaining({
          headerLineExample: 'Authorization: Bearer ktclaw_a2a_secret',
        }),
      }),
    }));
  });

  it('revokes a self inbound access key before generic delete routes', async () => {
    revokeA2AInboundApiKeyInOpenClawMock.mockResolvedValue({
      snapshot: {
        enabled: true,
        inbound: { apiKeys: [] },
        outbound: { agents: {} },
      },
      revoked: true,
    });
    const ctx = createCtx() as {
      gatewayManager: {
        debouncedRestart: ReturnType<typeof vi.fn>;
      };
    };
    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/self/api-keys/teammate'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(deleteRemoteInstanceMock).not.toHaveBeenCalled();
    expect(revokeA2AInboundApiKeyInOpenClawMock).toHaveBeenCalledWith('teammate');
    expect(ctx.gatewayManager.debouncedRestart).toHaveBeenCalledWith(500);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      self: expect.objectContaining({
        reloadRequested: true,
      }),
    }));
  });

  it('updates metadata/auth without leaving the host route boundary', async () => {
    parseJsonBodyMock.mockResolvedValue({
      displayName: 'Renamed Remote',
      auth: {
        mode: 'headers',
        headers: {
          Authorization: 'Bearer 1',
        },
      },
    });
    updateRemoteInstanceMock.mockResolvedValue({
      id: 'ri-2',
      displayName: 'Renamed Remote',
    });
    listRemoteInstancesMock.mockResolvedValue([{ id: 'ri-2' }]);
    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/ri-2'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(updateRemoteInstanceMock).toHaveBeenCalledWith('ri-2', {
      displayName: 'Renamed Remote',
      agentCardUrl: undefined,
      auth: {
        mode: 'headers',
        token: undefined,
        headers: {
          Authorization: 'Bearer 1',
        },
      },
      agentCard: undefined,
    });
    expect(syncRemoteInstancesToA2APluginMock).toHaveBeenCalled();
  });

  it('refreshes the Agent Card through host-owned network work and updates instance state', async () => {
    getRemoteInstanceMock.mockResolvedValue({
      id: 'ri-3',
      displayName: 'Remote 3',
      agentCardUrl: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    });
    fetchAgentCardMock.mockResolvedValue({
      agentCard: {
        name: 'Remote 3 Updated',
        description: 'updated',
        url: 'https://remote.example/card.json',
        capabilities: ['message/send'],
        defaultInputModes: [],
        defaultOutputModes: [],
        skills: [],
        raw: {},
        fetchedAt: '2026-05-20T00:00:00.000Z',
      },
      latencyMs: 18,
      httpStatus: 200,
    });
    updateRemoteInstanceMock.mockResolvedValue({
      id: 'ri-3',
      displayName: 'Remote 3',
      agentCardUrl: 'https://remote.example/card.json',
    });
    listRemoteInstancesMock.mockResolvedValue([{ id: 'ri-3' }]);
    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/ri-3/refresh'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(fetchAgentCardMock).toHaveBeenCalledWith({
      url: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      instance: {
        id: 'ri-3',
        displayName: 'Remote 3',
        agentCardUrl: 'https://remote.example/card.json',
      },
    });
  });

  it('runs a connection test behind the host route and persists health status', async () => {
    getRemoteInstanceMock.mockResolvedValue({
      id: 'ri-4',
      displayName: 'Remote 4',
      agentCardUrl: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    });
    fetchAgentCardMock.mockResolvedValue({
      agentCard: {
        name: 'Remote 4',
        description: 'ready',
        url: 'https://remote.example/card.json',
        capabilities: [],
        defaultInputModes: [],
        defaultOutputModes: [],
        skills: [],
        raw: {},
        fetchedAt: '2026-05-20T00:00:00.000Z',
      },
      latencyMs: 11,
      httpStatus: 200,
    });
    updateRemoteInstanceMock
      .mockResolvedValueOnce({
        id: 'ri-4',
        displayName: 'Remote 4',
        agentCardUrl: 'https://remote.example/card.json',
        auth: { mode: 'none', headers: {} },
      })
      .mockResolvedValueOnce({
        id: 'ri-4',
        displayName: 'Remote 4',
        health: { status: 'ok' },
      });
    testRemoteInstanceConnectionMock.mockResolvedValue({
      success: true,
      runtimeSynced: true,
      latencyMs: 11,
      httpStatus: 200,
      message: 'Agent Card fetched and A2A plugin configuration synced',
    });

    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/ri-4/test'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(testRemoteInstanceConnectionMock).toHaveBeenCalledWith({
      id: 'ri-4',
      displayName: 'Remote 4',
      agentCardUrl: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    }, {
      latencyMs: 11,
      httpStatus: 200,
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      result: expect.objectContaining({
        runtimeSynced: true,
      }),
    }));
  });

  it('sends a remote-instance conversation message with preserved A2A continuity ids', async () => {
    parseJsonBodyMock.mockResolvedValue({
      message: 'Continue the remote task',
      context_id: 'ctx-123',
      task_id: 'task-123',
    });
    getRemoteInstanceMock.mockResolvedValue({
      id: 'ri-6',
      displayName: 'Remote 6',
      agentCardUrl: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    });
    sendRemoteInstanceMessageMock.mockResolvedValue({
      success: true,
      tool: 'a2a_send_message',
      agent_id: 'ri-6',
      agentId: 'ri-6',
      context_id: 'ctx-456',
      contextId: 'ctx-456',
      task_id: 'task-456',
      taskId: 'task-456',
      state: 'completed',
      status: { state: 'completed' },
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: 'Remote answer',
        parts: [{ kind: 'text', text: 'Remote answer' }],
        raw: {},
        createdAt: '2026-05-20T00:00:00.000Z',
      },
      messages: [{
        id: 'msg-1',
        role: 'assistant',
        content: 'Remote answer',
        parts: [{ kind: 'text', text: 'Remote answer' }],
        raw: {},
        createdAt: '2026-05-20T00:00:00.000Z',
      }],
      artifacts: [],
      raw: { id: 'task-456', contextId: 'ctx-456' },
    });

    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/ri-6/conversation/messages'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(sendRemoteInstanceMessageMock).toHaveBeenCalledWith({
      id: 'ri-6',
      displayName: 'Remote 6',
      agentCardUrl: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    }, {
      message: 'Continue the remote task',
      contextId: 'ctx-123',
      taskId: undefined,
      timeout: undefined,
      data: undefined,
      files: undefined,
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      conversation: expect.objectContaining({
        context_id: 'ctx-456',
        task_id: 'task-456',
      }),
      messages: [expect.objectContaining({
        role: 'assistant',
        content: 'Remote answer',
      })],
      runtime: expect.objectContaining({
        tool: 'a2a_send_message',
        raw: { id: 'task-456', contextId: 'ctx-456' },
      }),
    }));
  });

  it('only attaches to a remote A2A task when explicitly requested', async () => {
    parseJsonBodyMock.mockResolvedValue({
      message: 'Provide requested input',
      context_id: 'ctx-123',
      task_id: 'task-123',
      attachToTask: true,
    });
    getRemoteInstanceMock.mockResolvedValue({
      id: 'ri-6',
      displayName: 'Remote 6',
      agentCardUrl: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    });
    sendRemoteInstanceMessageMock.mockResolvedValue({
      success: true,
      tool: 'a2a_send_message',
      agent_id: 'ri-6',
      agentId: 'ri-6',
      context_id: 'ctx-123',
      contextId: 'ctx-123',
      task_id: 'task-123',
      taskId: 'task-123',
      state: 'input-required',
      status: { state: 'input-required' },
      message: null,
      messages: [],
      artifacts: [],
      raw: { id: 'task-123', contextId: 'ctx-123' },
    });

    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/ri-6/conversation/messages'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(sendRemoteInstanceMessageMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      contextId: 'ctx-123',
      taskId: 'task-123',
    }));
  });

  it('rejects blank remote-instance conversation messages before calling runtime', async () => {
    parseJsonBodyMock.mockResolvedValue({ message: '   ' });
    getRemoteInstanceMock.mockResolvedValue({
      id: 'ri-7',
      displayName: 'Remote 7',
      agentCardUrl: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    });

    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/ri-7/conversation/messages'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(sendRemoteInstanceMessageMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, {
      success: false,
      error: 'message is required',
    });
  });

  it('polls a remote-instance A2A task by task id', async () => {
    getRemoteInstanceMock.mockResolvedValue({
      id: 'ri-8',
      displayName: 'Remote 8',
      agentCardUrl: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    });
    getRemoteInstanceTaskMock.mockResolvedValue({
      success: true,
      tool: 'a2a_get_task',
      agent_id: 'ri-8',
      agentId: 'ri-8',
      context_id: 'ctx-8',
      contextId: 'ctx-8',
      task_id: 'task-8',
      taskId: 'task-8',
      state: 'working',
      status: { state: 'working' },
      message: null,
      messages: [],
      artifacts: [],
      raw: { id: 'task-8', contextId: 'ctx-8', status: { state: 'working' } },
    });

    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/ri-8/conversation/tasks/task-8?timeout=5&pollInterval=1'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(getRemoteInstanceTaskMock).toHaveBeenCalledWith({
      id: 'ri-8',
      displayName: 'Remote 8',
      agentCardUrl: 'https://remote.example/card.json',
      auth: { mode: 'none', headers: {} },
    }, {
      taskId: 'task-8',
      timeout: 5,
      pollInterval: 1,
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      conversation: expect.objectContaining({
        context_id: 'ctx-8',
        task_id: 'task-8',
        state: 'working',
      }),
      runtime: expect.objectContaining({
        tool: 'a2a_get_task',
      }),
    }));
  });

  it('deletes a remote instance and re-syncs plugin config', async () => {
    deleteRemoteInstanceMock.mockResolvedValue(true);
    listRemoteInstancesMock.mockResolvedValue([]);
    const { handleRemoteInstanceRoutes } = await import('@electron/api/routes/remote-instances');

    const handled = await handleRemoteInstanceRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/remote-instances/ri-5'),
      createCtx(),
    );

    expect(handled).toBe(true);
    expect(deleteRemoteInstanceMock).toHaveBeenCalledWith('ri-5');
    expect(syncRemoteInstancesToA2APluginMock).toHaveBeenCalledWith([]);
  });
});
