// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configStore, ktclawFiles, secretStore, spawnMock, statMock, sshClientInstances } = vi.hoisted(() => ({
  configStore: {
    current: {} as Record<string, unknown>,
  },
  ktclawFiles: new Map<string, string>(),
  secretStore: new Map<string, unknown>(),
  spawnMock: vi.fn(),
  statMock: vi.fn(async () => ({ size: 42 })),
  sshClientInstances: [] as Array<{
    handlers: Map<string, (...args: unknown[]) => void>;
    connect: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    sftp: ReturnType<typeof vi.fn>;
    sftpMkdir: ReturnType<typeof vi.fn>;
    sftpFastPut: ReturnType<typeof vi.fn>;
    sftpFastGet: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }>,
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
    stdin: {
      end: vi.fn(),
    },
    stdout: { on: onFor(stdoutListeners) },
    stderr: { on: onFor(stderrListeners) },
    on: onFor(listeners),
    kill: vi.fn(),
  };
}

function extractGatewayPayload(command: string): Record<string, unknown> {
  const marker = 'KTCLAW_INTERCOM_GATEWAY_PAYLOAD_B64=';
  const index = command.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  const fragment = command.slice(index + marker.length);
  const match = fragment.match(/[A-Za-z0-9+/=]{24,}/);
  expect(match?.[0]).toBeTruthy();
  return JSON.parse(Buffer.from(match![0], 'base64').toString('utf8')) as Record<string, unknown>;
}

function extractPowerShellEncodedCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
  expect(match?.[1]).toBeTruthy();
  return Buffer.from(match![1], 'base64').toString('utf16le');
}

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(function ClientMock() {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const instance = {
      handlers,
      connect: vi.fn(() => {
        setImmediate(() => handlers.get('ready')?.());
        return instance;
      }),
      exec: vi.fn((_command: string, callback: (error: Error | undefined, channel: unknown) => void) => {
        const channelHandlers = new Map<string, (...args: unknown[]) => void>();
        const stderrHandlers = new Map<string, (...args: unknown[]) => void>();
        const channel = {
          stderr: {
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
              stderrHandlers.set(event, handler);
            }),
          },
          on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            channelHandlers.set(event, handler);
          }),
        };
        callback(undefined, channel);
        setImmediate(() => {
          channelHandlers.get('data')?.(Buffer.from('{"ok":true}\n'));
          channelHandlers.get('exit')?.(0);
          channelHandlers.get('close')?.();
        });
        return instance;
      }),
      sftpMkdir: vi.fn((_path: string, callback: (error?: Error) => void) => {
        callback();
      }),
      sftpFastPut: vi.fn((_localPath: string, _remotePath: string, callback: (error?: Error) => void) => {
        callback();
      }),
      sftpFastGet: vi.fn((_remotePath: string, _localPath: string, callback: (error?: Error) => void) => {
        callback();
      }),
      sftp: vi.fn((callback: (error: Error | undefined, sftp: unknown) => void) => {
        callback(undefined, {
          mkdir: instance.sftpMkdir,
          fastPut: instance.sftpFastPut,
          fastGet: instance.sftpFastGet,
        });
        return instance;
      }),
      end: vi.fn(() => instance),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
        return instance;
      }),
    };
    sshClientInstances.push(instance);
    return instance;
  }),
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

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: vi.fn(),
    readFile: vi.fn(async (filePath: string) => {
      const value = ktclawFiles.get(String(filePath).replace(/\\/g, '/'));
      if (value === undefined) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return value;
    }),
    writeFile: vi.fn(async (filePath: string, data: string) => {
      ktclawFiles.set(String(filePath).replace(/\\/g, '/'), data);
    }),
    stat: (...args: unknown[]) => statMock(...args),
  };
});

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
  getKTClawConfigDir: () => '/tmp/ktclaw',
  getOpenClawDir: () => '/repo/node_modules/openclaw',
  getOpenClawEntryPath: () => '/repo/node_modules/openclaw/openclaw.mjs',
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: vi.fn(async (accountId: string) => secretStore.get(accountId) ?? null),
  setProviderSecret: vi.fn(async (secret: { accountId: string }) => {
    secretStore.set(secret.accountId, structuredClone(secret));
  }),
  deleteProviderSecret: vi.fn(async (accountId: string) => {
    secretStore.delete(accountId);
  }),
}));

describe('intercom service', () => {
  beforeEach(() => {
    vi.resetModules();
    configStore.current = {};
    ktclawFiles.clear();
    secretStore.clear();
    sshClientInstances.length = 0;
    spawnMock.mockReset();
    spawnMock.mockReturnValue(createProcessMock({ stdout: '{"ok":true}\n' }));
    statMock.mockReset();
    statMock.mockResolvedValue({ size: 42 });
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

  it('uses a Tailscale IPv4 address when no private LAN address is available', async () => {
    const { selectBestIntercomLanIpv4Address } = await import('@electron/services/intercom');

    expect(selectBestIntercomLanIpv4Address({
      Meta: [{ family: 'IPv4', internal: false, address: '198.18.0.1' } as never],
      Tailscale: [{ family: 'IPv4', internal: false, address: '100.99.88.77' } as never],
    })).toBe('100.99.88.77');
  });

  it('reports host readiness for sharing this machine', async () => {
    const { getIntercomHostReadiness } = await import('@electron/services/intercom');

    const readiness = await getIntercomHostReadiness();

    expect(readiness).toEqual(expect.objectContaining({
      platform: process.platform,
      host: '10.101.208.55',
      sshUser: 'tester',
      sshPort: 22,
      agentId: 'main',
      sessionId: 'intercom',
      canPrepare: expect.any(Boolean),
      accessEnabled: expect.any(Boolean),
    }));
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lan-host', status: 'ok' }),
      expect.objectContaining({ id: 'ssh-user', status: 'ok' }),
      expect.objectContaining({ id: 'agent', status: 'ok' }),
    ]));
  });

  it('can close this host for remote SSH intercom access', async () => {
    const { setIntercomHostAccess } = await import('@electron/services/intercom');

    const result = await setIntercomHostAccess(false);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      started: true,
      status: expect.objectContaining({
        accessEnabled: expect.any(Boolean),
      }),
    }));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    const serialized = `${command} ${args.join(' ')}`;
    if (process.platform === 'win32') {
      const match = serialized.match(/-EncodedCommand','([^']+)'/);
      expect(match?.[1]).toBeTruthy();
      const decoded = Buffer.from(match?.[1] ?? '', 'base64').toString('utf16le');
      expect(decoded).toContain("Stop-Service -Name 'sshd'");
      expect(decoded).toContain("Disable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'");
    } else if (process.platform === 'darwin') {
      expect(serialized).toContain('systemsetup -setremotelogin off');
    } else {
      expect(serialized).toContain('disable --now ssh');
    }
  });

  it('persists an SSH route under KTClaw intercom config without touching OpenClaw root schema', async () => {
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

    expect(configStore.current).not.toHaveProperty('intercom');
    const stored = JSON.parse(ktclawFiles.get('/tmp/ktclaw/intercom.json') ?? '{}');
    expect(stored).toEqual(expect.objectContaining({
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

  it('migrates legacy OpenClaw root intercom config into KTClaw storage', async () => {
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
          },
        },
      },
    };
    const { getIntercomSnapshot } = await import('@electron/services/intercom');

    const snapshot = await getIntercomSnapshot();

    expect(snapshot.routes.find((route) => route.id === 'ops')).toEqual(expect.objectContaining({
      host: 'srv-c',
      agent: 'ops',
    }));
    expect(configStore.current).not.toHaveProperty('intercom');
    expect(JSON.parse(ktclawFiles.get('/tmp/ktclaw/intercom.json') ?? '{}')).toEqual(expect.objectContaining({
      agents: expect.objectContaining({
        ops: expect.objectContaining({
          host: 'srv-c',
          agent: 'ops',
        }),
      }),
    }));
  });

  it('stores SSH passwords in the local secret store instead of openclaw config', async () => {
    const { upsertIntercomRoute, getIntercomSnapshot } = await import('@electron/services/intercom');

    await upsertIntercomRoute({
      id: 'ops',
      displayName: 'Ops Agent',
      host: 'srv-c',
      agent: 'ops',
      transport: 'ssh',
      sshUser: 'ubuntu',
      sshPassword: 'linux-password',
    });

    expect(JSON.stringify(configStore.current)).not.toContain('linux-password');
    expect(secretStore.get('intercom:ssh:ops')).toEqual({
      type: 'local',
      accountId: 'intercom:ssh:ops',
      apiKey: 'linux-password',
    });
    const snapshot = await getIntercomSnapshot();
    expect(snapshot.routes.find((route) => route.id === 'ops')).toEqual(expect.objectContaining({
      sshPasswordConfigured: true,
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
    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe('ssh');
    expect(args.slice(0, -1)).toEqual([
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
    ]);
    expect(options).toEqual(expect.objectContaining({
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }));
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('KTCLAW_INTERCOM_GATEWAY_PAYLOAD_B64');
    expect(sshArgs.at(-1)).toContain('chat.send');
    expect(sshArgs.at(-1)).not.toContain('ktclaw-intercom');
    expect(sshArgs.at(-1)).not.toContain(' agent --local ');
    const payload = extractGatewayPayload(sshArgs.at(-1) ?? '');
    expect(payload).toEqual(expect.objectContaining({
      sessionKey: 'agent:ops:intercom',
      message: '[from agent dev] 更新头像',
      gatewayPort: 18789,
    }));
  });

  it('keeps the remote OpenClaw command prefix available for task CLI fallback', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({
      stdout: JSON.stringify({
        success: true,
        summary: 'Task completed',
        artifacts: [],
        logs: '',
        error: null,
      }),
    }));
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
            remoteCommand: 'ELECTRON_RUN_AS_NODE=1 /opt/KTClaw/ktclaw /opt/KTClaw/resources/openclaw/openclaw.mjs',
          },
        },
      },
    };
    const { sendIntercomTask } = await import('@electron/services/intercom');

    await sendIntercomTask({
      sender: 'dev',
      target: 'ops',
      taskId: 'task-prefix',
      action: 'remote_task',
      payload: { instruction: 'ping' },
      return: ['summary', 'artifacts', 'logs'],
    });

    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('/opt/KTClaw/ktclaw');
    expect(sshArgs.at(-1)).toContain('/opt/KTClaw/resources/openclaw/openclaw.mjs');
  });

  it('tries the remote Gateway fast path without cold-starting CLI for normal messages', async () => {
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
            remoteCommand: 'openclaw',
          },
        },
      },
    };
    const { sendIntercomMessage } = await import('@electron/services/intercom');

    await sendIntercomMessage({
      sender: 'dev',
      target: 'ops',
      message: 'ping',
    });

    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('KTCLAW_INTERCOM_GATEWAY_PAYLOAD_B64');
    expect(sshArgs.at(-1)).toContain('GET /ws HTTP/1.1');
    expect(sshArgs.at(-1)).toContain('"id": "openclaw-control-ui"');
    expect(sshArgs.at(-1)).toContain('"mode": "webchat"');
    expect(sshArgs.at(-1)).toContain('"caps": ["tool-events"]');
    expect(sshArgs.at(-1)).toContain('normal Intercom messages no longer cold-start openclaw agent automatically');
    expect(sshArgs.at(-1)).not.toContain('ktclaw-intercom');
    expect(sshArgs.at(-1)).not.toContain(' agent --local ');
  });

  it('uses the configured remote Gateway port for fast-path chat', async () => {
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
            remoteGatewayPort: 24567,
          },
        },
      },
    };
    const { sendIntercomMessage } = await import('@electron/services/intercom');

    await sendIntercomMessage({
      sender: 'dev',
      target: 'ops',
      message: 'ping',
    });

    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    const payload = extractGatewayPayload(sshArgs.at(-1) ?? '');
    expect(payload).toEqual(expect.objectContaining({
      gatewayPort: 24567,
      sessionKey: 'agent:ops:intercom',
      timeoutSeconds: 30,
    }));
    expect(sshArgs.at(-1)).toContain('127.0.0.1:24567');
  });

  it('returns a pending poll cursor when the remote Gateway dispatch is still running', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({
      stdout: JSON.stringify({
        messages: [],
        result: { dispatched: true },
        meta: {
          via: 'remote-gateway',
          status: 'running',
          beforeCount: 12,
          sessionKey: 'agent:ops:intercom',
        },
      }),
    }));
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
            remoteCommand: 'openclaw',
          },
        },
      },
    };
    const { sendIntercomMessage } = await import('@electron/services/intercom');

    const result = await sendIntercomMessage({
      sender: 'dev',
      target: 'ops',
      message: 'ping',
    });

    expect(result.pending).toBe(true);
    expect(result.poll).toEqual({
      sessionId: 'intercom',
      beforeCount: 12,
      status: 'running',
    });
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('subprocess.Popen');
    expect(sshArgs.at(-1)).toContain('sendHttpTimeoutSeconds');
  });

  it('polls remote Gateway history without starting an OpenClaw CLI fallback', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({
      stdout: JSON.stringify({
        messages: [{ role: 'assistant', content: [{ text: 'pong' }] }],
        meta: {
          via: 'remote-gateway-poll',
          status: 'completed',
          beforeCount: 12,
          sessionKey: 'agent:ops:intercom',
        },
      }),
    }));
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
            remoteCommand: 'openclaw',
          },
        },
      },
    };
    const { pollIntercomMessage } = await import('@electron/services/intercom');

    const result = await pollIntercomMessage({
      target: 'ops',
      sessionId: 'intercom',
      beforeCount: 12,
    });

    expect(result.pending).toBeUndefined();
    expect(result.stdout).toContain('pong');
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('chat.history');
    expect(sshArgs.at(-1)).not.toContain(' agent --local ');
    expect(sshArgs.at(-1)).not.toContain('ktclaw-intercom');
  });

  it('retries legacy openclaw routes with the bundled Linux KTClaw command when the wrapper points at /usr/ktclaw', async () => {
    spawnMock
      .mockReturnValueOnce(createProcessMock({
        stderr: 'Error: KTClaw executable not found at /usr/ktclaw\nPlease reinstall KTClaw or remove this script: /usr/local/bin/openclaw',
        exitCode: 1,
      }))
      .mockReturnValueOnce(createProcessMock({ stdout: '{"ok":true}\n' }));
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
            remoteCommand: 'openclaw',
          },
        },
      },
    };
    const { sendIntercomTask } = await import('@electron/services/intercom');

    const result = await sendIntercomTask({
      sender: 'dev',
      target: 'ops',
      taskId: 'task-retry',
      action: 'remote_task',
      payload: { instruction: 'ping' },
      return: ['summary', 'artifacts', 'logs'],
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      stdout: '{"ok":true}',
    }));
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const retryArgs = spawnMock.mock.calls[1][1] as string[];
    expect(retryArgs.at(-1)).toContain('/opt/KTClaw/ktclaw');
    expect(retryArgs.at(-1)).toContain('/opt/KTClaw/resources/openclaw/openclaw.mjs');
    expect(retryArgs.at(-1)).toContain('agent:ops:intercom-task-task-retry');
  });

  it('runs discovered POSIX openclaw scripts through sh when execute permission is missing', async () => {
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
            remoteCommand: 'openclaw',
          },
        },
      },
    };
    const { sendIntercomTask } = await import('@electron/services/intercom');

    await sendIntercomTask({
      sender: 'dev',
      target: 'ops',
      taskId: 'task-posix-script',
      action: 'remote_task',
      payload: { instruction: 'ping' },
      return: ['summary', 'artifacts', 'logs'],
    });

    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('if [ -x "$p" ]; then exec "$p" "$@"; fi');
    expect(sshArgs.at(-1)).toContain('if [ -f "$p" ]; then exec sh "$p" "$@"; fi');
  });

  it('does not retry with PowerShell when POSIX auto-discovery runs but cannot find OpenClaw', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({
      stderr: 'KTClaw/OpenClaw command not found. Install openclaw globally or set Remote OpenClaw command to the KTClaw/OpenClaw executable path.',
      exitCode: 127,
    }));
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'srv-c',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'ubuntu',
            remoteCommand: 'openclaw',
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
      message: expect.stringContaining('KTClaw/OpenClaw command not found'),
      exitCode: 127,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).not.toContain('powershell');
  });

  it('retries default SSH intercom routes with Windows auto-discovery when sh is unavailable', async () => {
    spawnMock
      .mockReturnValueOnce(createProcessMock({
        stderr: "'sh' is not recognized as an internal or external command",
        exitCode: 127,
      }))
      .mockReturnValueOnce(createProcessMock({ stdout: '{"ok":true}\n' }));
    configStore.current = {
      intercom: {
        agents: {
          ops: {
            host: 'win-pc',
            agent: 'ops',
            transport: 'ssh',
            sshUser: 'sunyb9',
            remoteCommand: 'openclaw',
          },
        },
      },
    };
    const { sendIntercomMessage } = await import('@electron/services/intercom');

    const result = await sendIntercomMessage({
      sender: 'dev',
      target: 'ops',
      message: 'ping',
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      stdout: '{"ok":true}',
    }));
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const retryArgs = spawnMock.mock.calls[1][1] as string[];
    expect(retryArgs.at(-1)).toContain('powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand');
    const windowsScript = extractPowerShellEncodedCommand(retryArgs.at(-1) ?? '');
    expect(windowsScript).toContain('Connect-KTClawGatewayWs');
    expect(windowsScript).toContain('id = "openclaw-control-ui"');
    expect(windowsScript).toContain('mode = "webchat"');
    expect(windowsScript).toContain('caps = @("tool-events")');
  });

  it('retries intercom messages with a clean session when stale history contains image_url content', async () => {
    spawnMock
      .mockReturnValueOnce(createProcessMock({
        stdout: '400 Failed to deserialize the JSON body into the target type: messages[75]: unknown variant image_url, expected text at line 1 column 197067',
      }))
      .mockReturnValueOnce(createProcessMock({ stdout: '{"ok":true,"message":"你好"}\n' }));
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

    const result = await sendIntercomMessage({
      sender: 'dev',
      target: 'ops',
      message: '你好',
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      stdout: '{"ok":true,"message":"你好"}',
    }));
    expect(result.sessionId).toMatch(/^intercom-text-[a-f0-9]{8}$/);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const retryArgs = spawnMock.mock.calls[1][1] as string[];
    const retryPayload = extractGatewayPayload(retryArgs.at(-1) ?? '');
    expect(retryPayload.sessionKey).toMatch(/^agent:ops:intercom-text-[a-f0-9]{8}$/);
    expect(retryPayload.message).toBe('[from agent dev] 你好');
    expect(retryArgs.at(-1)).not.toContain('ktclaw-intercom');
  });

  it('sends password-backed SSH intercom messages through ssh2', async () => {
    secretStore.set('intercom:ssh:ops', {
      type: 'local',
      accountId: 'intercom:ssh:ops',
      apiKey: 'linux-password',
    });
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
      message: 'ping',
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      command: 'ssh2',
      stdout: '{"ok":true}',
    }));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(sshClientInstances[0]?.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: 'srv-c',
      port: 2222,
      username: 'ubuntu',
      password: 'linux-password',
    }));
    const remoteCommand = sshClientInstances[0]?.exec.mock.calls[0]?.[0] as string;
    expect(remoteCommand).toContain('gateway_url = "http://127.0.0.1:%d/rpc" % gateway_port');
    expect(remoteCommand).toContain('GET /ws HTTP/1.1');
    expect(remoteCommand).toContain('"id": "openclaw-control-ui"');
    expect(remoteCommand).toContain('"mode": "webchat"');
    expect(remoteCommand).toContain('"caps": ["tool-events"]');
    const payload = extractGatewayPayload(remoteCommand);
    expect(payload).toEqual(expect.objectContaining({
      sessionKey: 'agent:ops:intercom',
      gatewayPort: 18789,
    }));
    expect(remoteCommand).not.toContain('ktclaw-intercom');
  });

  it('builds structured remote task messages and normalizes task results', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({
      stdout: [
        '[plugins] ready',
        JSON.stringify({
          success: true,
          summary: 'Task completed',
          artifacts: [
            { type: 'file', path: '~/.ktclaw/intercom/outbox/task-1/result.md' },
          ],
          logs: 'ran task',
          error: null,
        }),
      ].join('\n'),
    }));
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
    const { sendIntercomTask } = await import('@electron/services/intercom');

    const result = await sendIntercomTask({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      action: 'inspect_file',
      payload: { path: '/tmp/report.md' },
      return: ['summary', 'artifacts', 'logs'],
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      taskId: 'task-1',
      result: expect.objectContaining({
        success: true,
        summary: 'Task completed',
        logs: 'ran task',
        artifacts: [
          expect.objectContaining({
            type: 'file',
            path: '~/.ktclaw/intercom/outbox/task-1/result.md',
          }),
        ],
      }),
    }));
    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('remote_task');
    expect(sshArgs.at(-1)).toContain('"action": "inspect_file"');
    expect(sshArgs.at(-1)).toContain('agent:ops:intercom-task-task-1');
    expect(sshArgs.at(-1)).toContain('intercom-task-task-1');
    expect(result.sessionId).toBe('intercom-task-task-1');
  });

  it('uses a direct SSH text preview path for uploaded file inspection tasks', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({
      stdout: [
        'Uploaded file inspection completed through SSH fast path.',
        'Instruction: 这个文件内容是什么',
        '',
        '## report.md',
        'Path: ~/.ktclaw/intercom/inbox/dev/task-1/report.md',
        'Size: 42 bytes',
        '',
        '```text',
        'hello from uploaded file',
        '```',
      ].join('\n'),
    }));
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
    const { sendIntercomTask } = await import('@electron/services/intercom');

    const result = await sendIntercomTask({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      action: 'remote_task',
      payload: {
        instruction: '这个文件内容是什么',
        inboxFiles: [
          {
            name: 'report.md',
            path: '~/.ktclaw/intercom/inbox/dev/task-1/report.md',
            mimeType: 'text/markdown',
            size: 42,
          },
        ],
      },
      return: ['summary', 'artifacts', 'logs'],
    });

    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('head -c');
    expect(sshArgs.at(-1)).toContain('report.md');
    expect(sshArgs.at(-1)).not.toContain("'agent' '--local'");
    expect(result.result.summary).toContain('hello from uploaded file');
  });

  it('normalizes structured OpenClaw task output written to stderr', async () => {
    const { normalizeIntercomRemoteTaskCommandResult } = await import('@electron/services/intercom');

    const result = normalizeIntercomRemoteTaskCommandResult({
      stdout: '',
      stderr: JSON.stringify({
        payloads: [
          {
            text: 'The uploaded file says hello.',
            mediaUrl: null,
          },
        ],
        meta: {
          durationMs: 51364,
        },
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      summary: 'The uploaded file says hello.',
      artifacts: [],
      error: null,
    }));
  });

  it('asks the remote KTClaw desktop client to capture screenshots before shell fallbacks', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({
      stdout: JSON.stringify({
        success: true,
        summary: 'Screenshot captured.',
        artifacts: [
          { type: 'image', path: '~/.ktclaw/intercom/outbox/task-1/screenshot.png', name: 'screenshot.png', mimeType: 'image/png' },
        ],
        logs: 'Captured through KTClaw desktop screenshot request.',
        error: null,
      }),
    }));
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
    const { sendIntercomTask } = await import('@electron/services/intercom');

    const result = await sendIntercomTask({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      action: 'screenshot',
      payload: { outbox: '~/.ktclaw/intercom/outbox/task-1/', format: 'png' },
      return: ['summary', 'artifacts', 'logs'],
    });

    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('desktop-screenshot-requests');
    expect(sshArgs.at(-1)).not.toContain('remote_task');
    expect(sshArgs.at(-1)).not.toContain("'agent' '--local'");
    expect(result.result).toEqual(expect.objectContaining({
      summary: 'Screenshot captured.',
      artifacts: [
        expect.objectContaining({
          type: 'image',
          path: '~/.ktclaw/intercom/outbox/task-1/screenshot.png',
        }),
      ],
    }));
  });

  it('falls back to shell screenshot tools when the desktop screenshot service is unavailable', async () => {
    spawnMock
      .mockReturnValueOnce(createProcessMock({
        stderr: 'KTClaw desktop screenshot service did not accept within 3s',
        exitCode: 86,
      }))
      .mockReturnValueOnce(createProcessMock({
        stdout: JSON.stringify({
          success: true,
          summary: 'Screenshot captured.',
          artifacts: [
            { type: 'image', path: '~/.ktclaw/intercom/outbox/task-1/screenshot.png', name: 'screenshot.png', mimeType: 'image/png' },
          ],
          logs: 'Captured through SSH direct screenshot fast path.',
          error: null,
        }),
      }));
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
    const { sendIntercomTask } = await import('@electron/services/intercom');

    const result = await sendIntercomTask({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      action: 'screenshot',
      payload: { outbox: '~/.ktclaw/intercom/outbox/task-1/', format: 'png' },
      return: ['summary', 'artifacts', 'logs'],
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const desktopCommand = spawnMock.mock.calls[0][1] as string[];
    const fallbackCommand = spawnMock.mock.calls[1][1] as string[];
    expect(desktopCommand.at(-1)).toContain('desktop-screenshot-requests');
    expect(fallbackCommand.at(-1)).toContain('gnome-screenshot');
    expect(fallbackCommand.at(-1)).not.toContain('remote_task');
    expect(result.result).toEqual(expect.objectContaining({
      success: true,
      summary: 'Screenshot captured.',
      artifacts: [
        expect.objectContaining({
          type: 'image',
          path: '~/.ktclaw/intercom/outbox/task-1/screenshot.png',
        }),
      ],
    }));
  });

  it('asks the remote KTClaw desktop client to take camera photos before tool fallbacks', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({
      stdout: JSON.stringify({
        success: true,
        summary: 'Camera photo captured.',
        artifacts: [
          { type: 'image', path: '~/.ktclaw/intercom/outbox/task-1/camera.jpg', name: 'camera.jpg', mimeType: 'image/jpeg' },
        ],
        logs: 'Captured through KTClaw desktop camera UI.',
        error: null,
      }),
    }));
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
    const { sendIntercomTask } = await import('@electron/services/intercom');

    const result = await sendIntercomTask({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      action: 'camera',
      payload: { outbox: '~/.ktclaw/intercom/outbox/task-1/', format: 'jpg' },
      return: ['summary', 'artifacts', 'logs'],
    });

    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain('desktop-camera-requests');
    expect(sshArgs.at(-1)).not.toContain('ffmpeg');
    expect(sshArgs.at(-1)).not.toContain('remote_task');
    expect(result.result).toEqual(expect.objectContaining({
      summary: 'Camera photo captured.',
      artifacts: [
        expect.objectContaining({
          type: 'image',
          path: '~/.ktclaw/intercom/outbox/task-1/camera.jpg',
        }),
      ],
    }));
  });

  it('falls back to camera tools when the desktop camera request is cancelled', async () => {
    spawnMock
      .mockReturnValueOnce(createProcessMock({
        stdout: JSON.stringify({
          success: false,
          summary: '',
          artifacts: [],
          logs: 'KTClaw desktop camera UI did not return a photo.',
          error: 'Desktop camera request was cancelled.',
        }),
      }))
      .mockReturnValueOnce(createProcessMock({
        stdout: JSON.stringify({
          success: true,
          summary: 'Camera photo captured.',
          artifacts: [
            { type: 'image', path: '~/.ktclaw/intercom/outbox/task-1/camera.jpg', name: 'camera.jpg', mimeType: 'image/jpeg' },
          ],
          logs: 'Captured through SSH direct camera tool fallback.',
          error: null,
        }),
      }));
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
    const { sendIntercomTask } = await import('@electron/services/intercom');

    const result = await sendIntercomTask({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      action: 'camera',
      payload: { outbox: '~/.ktclaw/intercom/outbox/task-1/', format: 'jpg' },
      return: ['summary', 'artifacts', 'logs'],
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const desktopCommand = spawnMock.mock.calls[0][1] as string[];
    const fallbackCommand = spawnMock.mock.calls[1][1] as string[];
    expect(desktopCommand.at(-1)).toContain('desktop-camera-requests');
    expect(fallbackCommand.at(-1)).toContain('fswebcam');
    expect(fallbackCommand.at(-1)).toContain('ffmpeg');
    expect(result.result).toEqual(expect.objectContaining({
      success: true,
      summary: 'Camera photo captured.',
      artifacts: [
        expect.objectContaining({
          type: 'image',
          path: '~/.ktclaw/intercom/outbox/task-1/camera.jpg',
        }),
      ],
    }));
  });

  it('falls back to assistant text when a remote task returns ordinary OpenClaw messages', async () => {
    const { normalizeIntercomRemoteTaskResult } = await import('@electron/services/intercom');

    expect(normalizeIntercomRemoteTaskResult(JSON.stringify({
      messages: [
        { role: 'assistant', content: [{ text: 'I handled it.' }] },
      ],
    }))).toEqual({
      success: true,
      summary: 'I handled it.',
      artifacts: [],
      logs: expect.any(String),
      error: null,
    });
  });

  it('collects screenshot artifacts from OpenClaw wrapped payload output', async () => {
    const { normalizeIntercomRemoteTaskResult } = await import('@electron/services/intercom');

    const result = normalizeIntercomRemoteTaskResult(JSON.stringify({
      runId: 'run-1',
      status: 'ok',
      summary: 'completed',
      result: {
        payloads: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  summary: 'Screenshot saved',
                  artifacts: [
                    {
                      type: 'image',
                      path: '~/.ktclaw/intercom/outbox/task-1/screenshot.png',
                      name: 'screenshot.png',
                      mimeType: 'image/png',
                    },
                  ],
                  logs: 'captured screen',
                  error: null,
                }),
              },
            ],
          },
        ],
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      success: true,
      summary: 'Screenshot saved',
      artifacts: [
        expect.objectContaining({
          type: 'image',
          path: '~/.ktclaw/intercom/outbox/task-1/screenshot.png',
          mimeType: 'image/png',
        }),
      ],
    }));
  });

  it('prefers payload text over generic completed summaries in wrapped task output', async () => {
    const { normalizeIntercomRemoteTaskResult } = await import('@electron/services/intercom');

    const result = normalizeIntercomRemoteTaskResult(JSON.stringify({
      runId: 'run-1',
      status: 'ok',
      summary: 'completed',
      result: {
        payloads: [
          {
            content: [
              {
                text: '这是文件里的正文摘要。',
              },
            ],
          },
        ],
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      success: true,
      summary: '这是文件里的正文摘要。',
      artifacts: [],
    }));
  });

  it('collects outbox artifact paths mentioned in assistant text', async () => {
    const { normalizeIntercomRemoteTaskResult } = await import('@electron/services/intercom');

    const result = normalizeIntercomRemoteTaskResult(JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              text: 'completed: ~/.ktclaw/intercom/outbox/task-1/screenshot.png',
            },
          ],
        },
      ],
    }));

    expect(result.artifacts).toEqual([
      expect.objectContaining({
        type: 'image',
        path: '~/.ktclaw/intercom/outbox/task-1/screenshot.png',
      }),
    ]);
  });

  it('uploads files to the remote intercom inbox over SFTP', async () => {
    secretStore.set('intercom:ssh:ops', {
      type: 'local',
      accountId: 'intercom:ssh:ops',
      apiKey: 'linux-password',
    });
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
    const { uploadIntercomFiles } = await import('@electron/services/intercom');

    const result = await uploadIntercomFiles({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      files: [{ localPath: '/tmp/input.txt', fileName: 'input.txt', mimeType: 'text/plain' }],
    });

    expect(result.transfers[0]).toEqual(expect.objectContaining({
      direction: 'upload',
      status: 'success',
      fileName: 'input.txt',
      remotePath: '~/.ktclaw/intercom/inbox/dev/task-1/input.txt',
      localPath: '/tmp/input.txt',
    }));
    expect(sshClientInstances[0]?.sftpFastPut).toHaveBeenCalledWith(
      '/tmp/input.txt',
      '.ktclaw/intercom/inbox/dev/task-1/input.txt',
      expect.any(Function),
    );
  });

  it('uploads files with system sftp when no SSH password is saved', async () => {
    const child = createProcessMock();
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
    const { uploadIntercomFiles } = await import('@electron/services/intercom');

    const result = await uploadIntercomFiles({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      files: [{ localPath: '/tmp/input.txt', fileName: 'input.txt', mimeType: 'text/plain' }],
    });

    expect(result.transfers[0]).toEqual(expect.objectContaining({
      direction: 'upload',
      status: 'success',
      remotePath: '~/.ktclaw/intercom/inbox/dev/task-1/input.txt',
    }));
    expect(spawnMock).toHaveBeenCalledWith(
      'sftp',
      expect.arrayContaining(['ubuntu@srv-c']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith(expect.stringContaining('put "/tmp/input.txt" ".ktclaw/intercom/inbox/dev/task-1/input.txt"'));
  });

  it('downloads artifacts from the remote outbox into the local artifact cache', async () => {
    secretStore.set('intercom:ssh:ops', {
      type: 'local',
      accountId: 'intercom:ssh:ops',
      apiKey: 'linux-password',
    });
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
    const { downloadIntercomArtifacts } = await import('@electron/services/intercom');

    const result = await downloadIntercomArtifacts({
      target: 'ops',
      taskId: 'task-1',
      artifacts: [{ path: '~/.ktclaw/intercom/outbox/task-1/result.png', type: 'image' }],
    });

    expect(result.transfers[0]).toEqual(expect.objectContaining({
      direction: 'download',
      status: 'success',
      fileName: 'result.png',
      remotePath: '~/.ktclaw/intercom/outbox/task-1/result.png',
    }));
    expect(result.transfers[0]?.localPath.replace(/\\/g, '/')).toBe('/tmp/ktclaw/intercom/artifacts/ops/task-1/result.png');
    expect(sshClientInstances[0]?.sftpFastGet).toHaveBeenCalledWith(
      '.ktclaw/intercom/outbox/task-1/result.png',
      expect.stringContaining('result.png'),
      expect.any(Function),
    );
  });

  it('rejects empty downloaded image artifacts before rendering previews', async () => {
    secretStore.set('intercom:ssh:ops', {
      type: 'local',
      accountId: 'intercom:ssh:ops',
      apiKey: 'linux-password',
    });
    statMock.mockResolvedValueOnce({ size: 0 });
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
    const { downloadIntercomArtifacts } = await import('@electron/services/intercom');

    await expect(downloadIntercomArtifacts({
      target: 'ops',
      taskId: 'task-1',
      artifacts: [{ path: '~/.ktclaw/intercom/outbox/task-1/result.png', type: 'image', mimeType: 'image/png' }],
    })).rejects.toThrow('Downloaded remote image artifact is empty');
  });

  it('downloads artifacts with system sftp when no SSH password is saved', async () => {
    const child = createProcessMock();
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
    const { downloadIntercomArtifacts } = await import('@electron/services/intercom');

    const result = await downloadIntercomArtifacts({
      target: 'ops',
      taskId: 'task-1',
      artifacts: [{ path: '~/.ktclaw/intercom/outbox/task-1/result.png', type: 'image' }],
    });

    expect(result.transfers[0]).toEqual(expect.objectContaining({
      direction: 'download',
      status: 'success',
      fileName: 'result.png',
      remotePath: '~/.ktclaw/intercom/outbox/task-1/result.png',
    }));
    expect(spawnMock).toHaveBeenCalledWith(
      'sftp',
      expect.arrayContaining(['ubuntu@srv-c']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith(expect.stringContaining('get ".ktclaw/intercom/outbox/task-1/result.png"'));
  });

  it('surfaces system sftp errors when passwordless transfer cannot connect', async () => {
    spawnMock.mockReturnValueOnce(createProcessMock({
      stderr: 'Permission denied (publickey).',
      exitCode: 1,
    }));
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
    const { uploadIntercomFiles } = await import('@electron/services/intercom');

    await expect(uploadIntercomFiles({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      files: [{ localPath: '/tmp/input.txt' }],
    })).rejects.toThrow('Intercom SFTP command failed: Permission denied');
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
      await vi.advanceTimersByTimeAsync(300_000);

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
        '--to',
        'agent:dev:intercom',
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
