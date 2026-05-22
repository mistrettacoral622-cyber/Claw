// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configStore, spawnMock } = vi.hoisted(() => ({
  configStore: {
    current: {} as Record<string, unknown>,
  },
  spawnMock: vi.fn(),
}));

function createProcessMock(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: Error;
  close?: boolean;
} = {}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const stdoutListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const stderrListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const onFor = (target: Map<string, Array<(...args: unknown[]) => void>>) => (
    event: string,
    handler: (...args: unknown[]) => void,
  ) => {
    target.set(event, [...(target.get(event) ?? []), handler]);
  };
  const emit = (target: Map<string, Array<(...args: unknown[]) => void>>, event: string, ...args: unknown[]) => {
    for (const handler of target.get(event) ?? []) {
      handler(...args);
    }
  };

  if (options.close !== false) {
    setImmediate(() => {
      if (options.error) {
        emit(listeners, 'error', options.error);
        return;
      }
      if (options.stdout) {
        emit(stdoutListeners, 'data', Buffer.from(options.stdout));
      }
      if (options.stderr) {
        emit(stderrListeners, 'data', Buffer.from(options.stderr));
      }
      emit(listeners, 'close', options.exitCode ?? 0);
    });
  }

  return {
    stdout: { on: onFor(stdoutListeners) },
    stderr: { on: onFor(stderrListeners) },
    on: onFor(listeners),
    kill: vi.fn(),
  };
}

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    hostname: () => 'desk-a',
    networkInterfaces: () => ({
      Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.24.32.1' }],
      'Wi-Fi': [{ family: 'IPv4', internal: false, address: '10.101.208.55' }],
    }),
    userInfo: () => ({ username: 'tester' }),
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
    spawnMock.mockReturnValue(createProcessMock({ stdout: '{"ok":true}\n' }));
  });

  it('lists local agents as local intercom routes by default', async () => {
    const { getIntercomSnapshot } = await import('@electron/services/intercom');

    const snapshot = await getIntercomSnapshot();

    expect(snapshot.localHost).toBe('desk-a');
    expect(snapshot.selfConfig).toEqual(expect.objectContaining({
      host: '10.101.208.55',
      sshUser: 'tester',
      sshPort: 22,
      agentId: 'main',
      sessionId: 'intercom',
      remoteCommand: 'openclaw',
      routeIdExample: '10.101.208.55-main',
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

  it('selects the best LAN IPv4 address for the host other machines should use', async () => {
    const { selectBestIntercomLanIpv4Address } = await import('@electron/services/intercom');

    expect(selectBestIntercomLanIpv4Address({
      'vEthernet (Default Switch)': [{ family: 'IPv4', internal: false, address: '172.24.16.1' } as never],
      Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.45' } as never],
      Tailscale: [{ family: 'IPv4', internal: false, address: '100.99.88.77' } as never],
    })).toBe('192.168.1.45');
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

  it('sends SSH intercom messages and captures remote output', async () => {
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
      queued: false,
      transport: 'ssh',
      host: 'srv-c',
      agent: 'ops',
      sessionId: 'intercom',
      exitCode: 0,
      stdout: '{"ok":true}',
    }));
    expect(spawnMock).toHaveBeenCalledWith(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ConnectionAttempts=1',
        '-o',
        'NumberOfPasswordPrompts=0',
        '-p',
        '2222',
        'ubuntu@srv-c',
        expect.stringContaining("openclaw 'agent' '--agent' 'ops' '--session-id' 'intercom' '--message'"),
      ],
      expect.objectContaining({
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('[from agent dev] 更新头像');
  });

  it('times out intercom commands that never exit', async () => {
    vi.useFakeTimers();
    try {
      const child = createProcessMock({ close: false });
      spawnMock.mockReturnValueOnce(child);
      configStore.current = {
        intercom: {
          agents: {
            ops: {
              host: 'srv-c',
              agent: 'ops',
              transport: 'ssh',
              sshUser: 'ubuntu',
            },
          },
        },
      };
      const { sendIntercomMessage } = await import('@electron/services/intercom');

      const sendPromise = expect(sendIntercomMessage({
        sender: 'dev',
        target: 'ops',
        message: 'ping',
      })).rejects.toMatchObject({
        message: expect.stringContaining('timed out'),
        exitCode: null,
        stderr: expect.stringContaining('timed out'),
      });
      await vi.advanceTimersByTimeAsync(60_000);

      await sendPromise;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects SSH intercom messages when the remote command exits non-zero', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({ stderr: 'ssh: Could not resolve hostname sunyb9-pc', exitCode: 255 }));
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'sunyb9-pc',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
          },
        },
      },
    };
    const { sendIntercomMessage } = await import('@electron/services/intercom');

    await expect(sendIntercomMessage({
      sender: 'dev',
      target: 'ops',
      message: 'ping',
    })).rejects.toMatchObject({
      message: expect.stringContaining('Could not resolve hostname'),
      exitCode: 255,
      stderr: 'ssh: Could not resolve hostname sunyb9-pc',
    });
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
