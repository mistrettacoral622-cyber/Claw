// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configStore, spawnMock } = vi.hoisted(() => ({
  configStore: {
    current: {} as Record<string, unknown>,
  },
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    hostname: () => 'desk-a',
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/ktclaw-user-data',
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
  },
}));

vi.mock('@electron/utils/channel-config', () => ({
  readOpenClawConfig: async () => structuredClone(configStore.current),
  writeOpenClawConfig: async (config: Record<string, unknown>) => {
    configStore.current = structuredClone(config);
  },
}));

vi.mock('@electron/utils/config-mutex', () => ({
  withConfigLock: async <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('@electron/utils/agent-config', () => ({
  listAgentsSnapshot: async () => ({
    agents: [
      { id: 'main', name: 'Main', workspace: '~/.openclaw/workspace' },
      { id: 'dev', name: 'Dev', workspace: '~/.openclaw/workspace-dev' },
    ],
    defaultAgentId: 'main',
    configuredChannelTypes: [],
    channelOwners: {},
  }),
}));

vi.mock('@electron/utils/paths', () => ({
  expandPath: (value: string) => value.replace(/^~/, '/home/tester'),
  getOpenClawDir: () => '/repo/node_modules/openclaw',
  getOpenClawEntryPath: () => '/repo/node_modules/openclaw/openclaw.mjs',
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

describe('intercom service', () => {
  beforeEach(() => {
    vi.resetModules();
    configStore.current = {};
    spawnMock.mockReset();
    spawnMock.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(),
    });
  });

  it('lists local agents as local intercom routes by default', async () => {
    const { getIntercomSnapshot } = await import('@electron/services/intercom');

    const snapshot = await getIntercomSnapshot();

    expect(snapshot.localHost).toBe('desk-a');
    expect(snapshot.selfConfig).toEqual(expect.objectContaining({
      host: 'desk-a',
      sshPort: 22,
      agentId: 'main',
      sessionId: 'intercom',
      remoteCommand: 'openclaw',
      routeIdExample: 'desk-a-main',
    }));
    expect(snapshot.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'main',
        transport: 'local',
        host: 'desk-a',
        source: 'local',
      }),
      expect.objectContaining({
        id: 'dev',
        transport: 'local',
        host: 'desk-a',
        source: 'local',
      }),
    ]));
  });

  it('persists an SSH route under openclaw intercom agents', async () => {
    const { upsertIntercomRoute } = await import('@electron/services/intercom');

    await upsertIntercomRoute({
      id: 'ops',
      displayName: 'Ops Agent',
      host: 'srv-c',
      agent: 'ops',
      transport: 'ssh',
      sshUser: 'ubuntu',
      sshPort: 2222,
    });

    expect(configStore.current.intercom).toEqual(expect.objectContaining({
      localHost: 'desk-a',
      defaultSessionId: 'intercom',
      agents: {
        ops: expect.objectContaining({
          displayName: 'Ops Agent',
          host: 'srv-c',
          agent: 'ops',
          transport: 'ssh',
          sshUser: 'ubuntu',
          sshPort: 2222,
        }),
      },
    }));
  });

  it('sends SSH intercom messages through a detached ssh command', async () => {
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
            sshPort: 2222,
          },
        },
      },
    };
    const { sendIntercomMessage } = await import('@electron/services/intercom');

    const result = await sendIntercomMessage({
      sender: 'dev',
      target: 'ops',
      message: '更新头像',
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      transport: 'ssh',
      host: 'srv-c',
      agent: 'ops',
      sessionId: 'intercom',
    }));
    expect(spawnMock).toHaveBeenCalledWith(
      'ssh',
      [
        '-p',
        '2222',
        'ubuntu@srv-c',
        expect.stringContaining("openclaw 'agent' '--agent' 'ops' '--session-id' 'intercom' '--message'"),
      ],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs[3]).toContain('[from agent dev] 更新头像');
  });

  it('sends local intercom messages with the bundled OpenClaw entry', async () => {
    const { sendIntercomMessage } = await import('@electron/services/intercom');

    await sendIntercomMessage({
      sender: 'main',
      target: 'dev',
      message: '请同步状态',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        '/repo/node_modules/openclaw/openclaw.mjs',
        'agent',
        '--agent',
        'dev',
        '--session-id',
        'intercom',
        '--message',
        '[from agent main] 请同步状态',
        '--json',
      ],
      expect.objectContaining({
        cwd: '/repo/node_modules/openclaw',
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
          OPENCLAW_EMBEDDED_IN: 'KTClaw',
        }),
      }),
    );
  });
});
