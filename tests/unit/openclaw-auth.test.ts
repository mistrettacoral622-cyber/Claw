import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome, testUserData, mockLoggerInfo, mockLoggerWarn, mockLoggerError } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    testHome: `/tmp/clawx-openclaw-auth-${suffix}`,
    testUserData: `/tmp/clawx-openclaw-auth-user-data-${suffix}`,
    mockLoggerInfo: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => testUserData,
    getVersion: () => '0.0.0-test',
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
  debug: vi.fn(),
  info: mockLoggerInfo,
  warn: mockLoggerWarn,
  error: mockLoggerError,
}));

async function writeOpenClawJson(config: unknown): Promise<void> {
  const openclawDir = join(testHome, '.openclaw');
  await mkdir(openclawDir, { recursive: true });
  await writeFile(join(openclawDir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function readOpenClawJson(): Promise<Record<string, unknown>> {
  const content = await readFile(join(testHome, '.openclaw', 'openclaw.json'), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

async function readAuthProfiles(agentId: string): Promise<Record<string, unknown>> {
  const content = await readFile(join(testHome, '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json'), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

describe('saveProviderKeyToOpenClaw', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('only syncs auth profiles for configured agents', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'main',
            name: 'Main',
            default: true,
            workspace: '~/.openclaw/workspace',
            agentDir: '~/.openclaw/agents/main/agent',
          },
          {
            id: 'test3',
            name: 'test3',
            workspace: '~/.openclaw/workspace-test3',
            agentDir: '~/.openclaw/agents/test3/agent',
          },
        ],
      },
    });

    await mkdir(join(testHome, '.openclaw', 'agents', 'test2', 'agent'), { recursive: true });
    await writeFile(
      join(testHome, '.openclaw', 'agents', 'test2', 'agent', 'auth-profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: {
          'legacy:default': {
            type: 'api_key',
            provider: 'legacy',
            key: 'legacy-key',
          },
        },
      }, null, 2),
      'utf8',
    );

    const { saveProviderKeyToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await saveProviderKeyToOpenClaw('openrouter', 'sk-test');

    const mainProfiles = await readAuthProfiles('main');
    const test3Profiles = await readAuthProfiles('test3');
    const staleProfiles = await readAuthProfiles('test2');

    expect((mainProfiles.profiles as Record<string, { key: string }>)['openrouter:default'].key).toBe('sk-test');
    expect((test3Profiles.profiles as Record<string, { key: string }>)['openrouter:default'].key).toBe('sk-test');
    expect(staleProfiles.profiles).toEqual({
      'legacy:default': {
        type: 'api_key',
        provider: 'legacy',
        key: 'legacy-key',
      },
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'Saved API key for provider "openrouter" to OpenClaw auth-profiles (agents: main, test3)',
    );
  });
});

describe('syncProviderConfigToOpenClaw', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('marks registered OpenAI-compatible local models as image-capable by default', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            api: 'openai-responses',
            models: [
              { id: 'Qwen3.5-9B', name: 'Qwen3.5-9B' },
            ],
          },
        },
      },
    });

    const { syncProviderConfigToOpenClaw } = await import('@electron/utils/openclaw-auth');

    await syncProviderConfigToOpenClaw('openai', 'Qwen3.5-9B', {
      baseUrl: 'http://10.101.80.18:8888/v1',
      api: 'openai-completions',
      apiKeyEnv: 'OPENAI_API_KEY',
    });

    const config = await readOpenClawJson();
    const provider = (config.models as Record<string, unknown>).providers as Record<string, {
      models: Array<Record<string, unknown>>;
    }>;

    expect(provider.openai.models).toContainEqual(expect.objectContaining({
      id: 'Qwen3.5-9B',
      name: 'Qwen3.5-9B',
      input: ['text', 'image'],
    }));
  });
});

describe('A2A inbound OpenClaw config helpers', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('updates inbound config while preserving existing outbound A2A agents', async () => {
    await writeOpenClawJson({
      plugins: {
        allow: ['a2a'],
        entries: {
          a2a: {
            enabled: true,
            config: {
              outbound: {
                agents: {
                  remote: {
                    url: 'https://remote.example/.well-known/agent-card.json',
                    custom_headers: {
                      Authorization: 'Bearer remote-key',
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const { updateA2AInboundConfigInOpenClaw } = await import('@electron/utils/openclaw-auth');

    await updateA2AInboundConfigInOpenClaw({
      enabled: true,
      agentCard: {
        name: 'Shared KTClaw',
        description: 'My local desktop agent',
      },
      allowUnauthenticated: false,
    });

    const config = await readOpenClawJson();
    const plugins = config.plugins as {
      allow?: string[];
      entries?: Record<string, {
        enabled?: boolean;
        config?: Record<string, unknown>;
      }>;
    };
    const a2aConfig = plugins.entries?.a2a?.config as {
      inbound?: Record<string, unknown>;
      outbound?: Record<string, unknown>;
    };

    expect(plugins.allow).toContain('a2a');
    expect(plugins.entries?.a2a?.enabled).toBe(true);
    expect(a2aConfig.inbound).toEqual({
      agentCard: {
        name: 'Shared KTClaw',
        description: 'My local desktop agent',
      },
      allowUnauthenticated: false,
    });
    expect(a2aConfig.outbound).toEqual({
      agents: {
        remote: {
          url: 'https://remote.example/.well-known/agent-card.json',
          custom_headers: {
            Authorization: 'Bearer remote-key',
          },
        },
      },
    });
  });

  it('generates and revokes inbound API keys without exposing unrelated config', async () => {
    await writeOpenClawJson({});
    const {
      generateA2AInboundApiKeyInOpenClaw,
      getA2APluginConfigFromOpenClaw,
      revokeA2AInboundApiKeyInOpenClaw,
    } = await import('@electron/utils/openclaw-auth');

    const generated = await generateA2AInboundApiKeyInOpenClaw('teammate');

    expect(generated.apiKey.label).toBe('teammate');
    expect(generated.apiKey.key).toMatch(/^ktclaw_a2a_/);
    expect(generated.snapshot.inbound.apiKeys).toEqual([
      generated.apiKey,
    ]);

    const afterGenerate = await getA2APluginConfigFromOpenClaw();
    expect(afterGenerate.enabled).toBe(true);
    expect(afterGenerate.inbound.apiKeys).toEqual([
      generated.apiKey,
    ]);

    const revoked = await revokeA2AInboundApiKeyInOpenClaw('teammate');
    expect(revoked.revoked).toBe(true);
    expect(revoked.snapshot.inbound.apiKeys).toBeUndefined();

    const config = await readOpenClawJson();
    const plugins = config.plugins as {
      entries?: Record<string, { config?: { inbound?: Record<string, unknown> } }>;
    };
    expect(plugins.entries?.a2a?.config?.inbound?.apiKeys).toBeUndefined();
  });

  it('disables inbound sharing without letting sanitize re-enable the A2A plugin', async () => {
    await writeOpenClawJson({
      plugins: {
        allow: ['a2a'],
        entries: {
          a2a: {
            enabled: true,
            config: {
              inbound: {
                allowUnauthenticated: true,
              },
            },
          },
        },
      },
    });

    const {
      sanitizeOpenClawConfig,
      updateA2AInboundConfigInOpenClaw,
    } = await import('@electron/utils/openclaw-auth');

    await updateA2AInboundConfigInOpenClaw({ enabled: false });
    await sanitizeOpenClawConfig();

    const config = await readOpenClawJson();
    const plugins = config.plugins as { allow?: string[]; entries?: Record<string, { enabled?: boolean }> };
    expect(plugins.allow).not.toContain('a2a');
    expect(plugins.entries?.a2a?.enabled).toBe(false);
  });

  it('updates gateway bind mode for local-only and LAN sharing', async () => {
    await writeOpenClawJson({
      gateway: {
        mode: 'local',
        bind: '127.0.0.1',
      },
    });

    const {
      getGatewayExposureConfigFromOpenClaw,
      updateGatewayExposureConfigInOpenClaw,
    } = await import('@electron/utils/openclaw-auth');

    expect(await getGatewayExposureConfigFromOpenClaw()).toEqual({
      bindMode: 'loopback',
      tailscaleMode: 'off',
    });

    await updateGatewayExposureConfigInOpenClaw({ bindMode: 'lan' });
    const afterLan = await readOpenClawJson();
    expect((afterLan.gateway as Record<string, unknown>).bind).toBe('lan');

    await updateGatewayExposureConfigInOpenClaw({ bindMode: 'loopback' });
    const afterLoopback = await readOpenClawJson();
    expect((afterLoopback.gateway as Record<string, unknown>).bind).toBe('loopback');
  });

  it('keeps Tailscale serve/funnel exposure on loopback', async () => {
    await writeOpenClawJson({
      gateway: {
        bind: 'loopback',
        tailscale: {
          mode: 'serve',
        },
      },
    });

    const { updateGatewayExposureConfigInOpenClaw } = await import('@electron/utils/openclaw-auth');

    await expect(updateGatewayExposureConfigInOpenClaw({ bindMode: 'lan' }))
      .rejects
      .toThrow('gateway.bind must remain loopback when gateway.tailscale.mode=serve');
  });
});

describe('sanitizeOpenClawConfig', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('migrates legacy channels.wechat config to channels.openclaw-weixin', async () => {
    await writeOpenClawJson({
      channels: {
        wechat: {
          enabled: true,
          defaultAccount: 'default',
          accounts: {
            default: { enabled: true },
          },
        },
      },
      plugins: {
        allow: ['wechat'],
        entries: {
          wechat: { enabled: true },
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const config = await readOpenClawJson();
    const channels = config.channels as Record<string, unknown>;
    expect(channels.wechat).toBeUndefined();
    expect(channels['openclaw-weixin']).toBeDefined();

    const plugins = config.plugins as { allow?: string[]; entries?: Record<string, { enabled?: boolean }> };
    expect(plugins.allow).toContain('openclaw-weixin');
    expect(plugins.allow).not.toContain('wechat');
    expect(plugins.entries?.wechat).toBeUndefined();
    expect(plugins.entries?.['openclaw-weixin']?.enabled).toBe(true);
  });

  it('disables managed channel plugins that are not configured as active channels', async () => {
    await writeOpenClawJson({
      channels: {
        slack: {
          enabled: true,
        },
      },
      plugins: {
        entries: {
          'openclaw-lark': { enabled: true },
          'openclaw-weixin': { enabled: true },
          qqbot: { enabled: true },
          customPlugin: { enabled: true },
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const config = await readOpenClawJson();
    const plugins = config.plugins as { entries?: Record<string, { enabled?: boolean }> };
    expect(plugins.entries?.['openclaw-lark']?.enabled).toBe(false);
    expect(plugins.entries?.['openclaw-weixin']?.enabled).toBe(false);
    expect(plugins.entries?.qqbot?.enabled).toBe(false);
    expect(plugins.entries?.customPlugin?.enabled).toBe(true);
  });

  it('preserves an explicitly enabled a2a plugin entry', async () => {
    await writeOpenClawJson({
      plugins: {
        allow: ['a2a'],
        entries: {
          a2a: { enabled: true },
        },
      },
    });

    const { sanitizeOpenClawConfig } = await import('@electron/utils/openclaw-auth');
    await sanitizeOpenClawConfig();

    const config = await readOpenClawJson();
    const plugins = config.plugins as { allow?: string[]; entries?: Record<string, { enabled?: boolean }> };
    expect(plugins.allow).toContain('a2a');
    expect(plugins.entries?.a2a?.enabled).toBe(true);
  });
});
