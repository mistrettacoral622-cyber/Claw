// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configStore, ktclawFiles, secretStore, spawnMock, sshClientInstances } = vi.hoisted(() => ({
  configStore: {
    current: {} as Record<string, unknown>,
  },
  ktclawFiles: new Map<string, string>(),
  secretStore: new Map<string, unknown>(),
  spawnMock: vi.fn(),
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
    stat: vi.fn(async () => ({ size: 42 })),
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
    }));
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lan-host', status: 'ok' }),
      expect.objectContaining({ id: 'ssh-user', status: 'ok' }),
      expect.objectContaining({ id: 'agent', status: 'ok' }),
    ]));
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
        expect.stringContaining("'sh' '-lc'"),
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

  it('allows a remote OpenClaw command prefix with arguments', async () => {
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
    const { sendIntercomMessage } = await import('@electron/services/intercom');

    await sendIntercomMessage({
      sender: 'dev',
      target: 'ops',
      message: 'ping',
    });

    const sshArgs = spawnMock.mock.calls[0][1] as string[];
    expect(sshArgs.at(-1)).toContain("ELECTRON_RUN_AS_NODE='1' '/opt/KTClaw/ktclaw' '/opt/KTClaw/resources/openclaw/openclaw.mjs' 'agent'");
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
    expect(retryArgs.at(-1)).toContain("ELECTRON_RUN_AS_NODE='1' '/opt/KTClaw/ktclaw' '/opt/KTClaw/resources/openclaw/openclaw.mjs' 'agent'");
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
    const { sendIntercomMessage } = await import('@electron/services/intercom');

    await sendIntercomMessage({
      sender: 'dev',
      target: 'ops',
      message: 'ping',
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
    expect(retryArgs.at(-1)).toContain("'--session-id' 'intercom-text-");
    expect(retryArgs.at(-1)).toContain("[from agent dev] 你好");
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
    expect(sshClientInstances[0]?.exec).toHaveBeenCalledWith(
      expect.stringContaining("'sh' '-lc'"),
      expect.any(Function),
    );
    expect(sshClientInstances[0]?.exec).toHaveBeenCalledWith(
      expect.stringContaining("'agent' '--agent' 'ops'"),
      expect.any(Function),
    );
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
    expect(sshArgs.at(-1)).toContain("'--session-id' 'intercom-task-task-1'");
    expect(result.sessionId).toBe('intercom-task-task-1');
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
