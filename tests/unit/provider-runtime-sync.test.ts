import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayManager } from '@electron/gateway/manager';
import type { ProviderConfig } from '@electron/utils/secure-storage';

const mocks = vi.hoisted(() => ({
  getProviderAccount: vi.fn(),
  listProviderAccounts: vi.fn(),
  providerAccountToConfig: vi.fn((account: {
    id: string;
    label: string;
    vendorId: string;
    baseUrl?: string;
    apiProtocol?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
    model?: string;
    fallbackModels?: string[];
    fallbackAccountIds?: string[];
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  }) => ({
    id: account.id,
    name: account.label,
    type: account.vendorId,
    baseUrl: account.baseUrl,
    apiProtocol: account.apiProtocol,
    model: account.model,
    fallbackModels: account.fallbackModels,
    fallbackProviderIds: account.fallbackAccountIds,
    enabled: account.enabled,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  })),
  getProviderSecret: vi.fn(),
  getAllProviders: vi.fn(),
  getApiKey: vi.fn(),
  getDefaultProvider: vi.fn(),
  getProvider: vi.fn(),
  getProviderConfig: vi.fn(),
  getProviderDefaultModel: vi.fn(),
  removeProviderKeyFromOpenClaw: vi.fn(),
  removeProviderFromOpenClaw: vi.fn(),
  saveOAuthTokenToOpenClaw: vi.fn(),
  saveProviderKeyToOpenClaw: vi.fn(),
  setOpenClawDefaultModel: vi.fn(),
  setOpenClawDefaultModelWithOverride: vi.fn(),
  syncProviderConfigToOpenClaw: vi.fn(),
  updateAgentModelProvider: vi.fn(),
  readOpenClawConfig: vi.fn(),
  writeOpenClawConfig: vi.fn(),
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getProviderAccount: mocks.getProviderAccount,
  listProviderAccounts: mocks.listProviderAccounts,
  providerAccountToConfig: mocks.providerAccountToConfig,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: mocks.getProviderSecret,
}));

vi.mock('@electron/utils/secure-storage', () => ({
  getAllProviders: mocks.getAllProviders,
  getApiKey: mocks.getApiKey,
  getDefaultProvider: mocks.getDefaultProvider,
  getProvider: mocks.getProvider,
}));

vi.mock('@electron/utils/provider-registry', () => ({
  getProviderConfig: mocks.getProviderConfig,
  getProviderDefaultModel: mocks.getProviderDefaultModel,
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  removeProviderKeyFromOpenClaw: mocks.removeProviderKeyFromOpenClaw,
  removeProviderFromOpenClaw: mocks.removeProviderFromOpenClaw,
  saveOAuthTokenToOpenClaw: mocks.saveOAuthTokenToOpenClaw,
  saveProviderKeyToOpenClaw: mocks.saveProviderKeyToOpenClaw,
  setOpenClawDefaultModel: mocks.setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride: mocks.setOpenClawDefaultModelWithOverride,
  syncProviderConfigToOpenClaw: mocks.syncProviderConfigToOpenClaw,
  updateAgentModelProvider: mocks.updateAgentModelProvider,
}));

vi.mock('@electron/utils/channel-config', () => ({
  readOpenClawConfig: mocks.readOpenClawConfig,
  writeOpenClawConfig: mocks.writeOpenClawConfig,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  syncAllProviderAuthToRuntime,
  syncDefaultProviderToRuntime,
  syncDeletedProviderApiKeyToRuntime,
  syncDeletedProviderToRuntime,
  syncSavedProviderToRuntime,
  syncUpdatedProviderToRuntime,
} from '@electron/services/providers/provider-runtime-sync';

function createProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'moonshot',
    name: 'Moonshot',
    type: 'moonshot',
    model: 'kimi-k2.5',
    enabled: true,
    createdAt: '2026-03-14T00:00:00.000Z',
    updatedAt: '2026-03-14T00:00:00.000Z',
    ...overrides,
  };
}

function createGateway(state: 'running' | 'stopped' = 'running'): Pick<GatewayManager, 'debouncedReload' | 'debouncedRestart' | 'getStatus' | 'rpc'> {
  return {
    debouncedReload: vi.fn(),
    debouncedRestart: vi.fn(),
    getStatus: vi.fn(() => ({ state } as ReturnType<GatewayManager['getStatus']>)),
    rpc: vi.fn(async () => ({ success: true })),
  };
}

describe('provider-runtime-sync refresh strategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderAccount.mockResolvedValue(null);
    mocks.getProviderSecret.mockResolvedValue(undefined);
    mocks.getAllProviders.mockResolvedValue([]);
    mocks.getApiKey.mockResolvedValue('sk-test');
    mocks.getDefaultProvider.mockResolvedValue('moonshot');
    mocks.getProvider.mockResolvedValue(createProvider());
    mocks.getProviderDefaultModel.mockReturnValue('kimi-k2.5');
    mocks.getProviderConfig.mockReturnValue({
      api: 'openai-completions',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKeyEnv: 'MOONSHOT_API_KEY',
    });
    mocks.removeProviderKeyFromOpenClaw.mockResolvedValue(undefined);
    mocks.syncProviderConfigToOpenClaw.mockResolvedValue(undefined);
    mocks.setOpenClawDefaultModel.mockResolvedValue(undefined);
    mocks.setOpenClawDefaultModelWithOverride.mockResolvedValue(undefined);
    mocks.saveProviderKeyToOpenClaw.mockResolvedValue(undefined);
    mocks.removeProviderFromOpenClaw.mockResolvedValue(undefined);
    mocks.updateAgentModelProvider.mockResolvedValue(undefined);
    mocks.readOpenClawConfig.mockResolvedValue({});
    mocks.writeOpenClawConfig.mockResolvedValue(undefined);
  });

  it('does not force a gateway refresh after saving provider config', async () => {
    const gateway = createGateway('running');
    await syncSavedProviderToRuntime(createProvider(), undefined, gateway as GatewayManager);

    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
    expect(gateway.rpc).not.toHaveBeenCalled();
  });

  it('uses debouncedRestart after deleting provider config', async () => {
    const gateway = createGateway('running');
    await syncDeletedProviderToRuntime(createProvider(), 'moonshot', gateway as GatewayManager);

    expect(gateway.debouncedRestart).toHaveBeenCalledTimes(1);
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
  });

  it('removes only provider auth profile material when deleting API key', async () => {
    await syncDeletedProviderApiKeyToRuntime(createProvider(), 'moonshot');

    expect(mocks.removeProviderKeyFromOpenClaw).toHaveBeenCalledWith('moonshot');
    expect(mocks.removeProviderFromOpenClaw).not.toHaveBeenCalled();
  });

  it('uses secrets reload after an auth-only provider update', async () => {
    const gateway = createGateway('running');

    await syncUpdatedProviderToRuntime(
      createProvider(),
      'sk-rotated',
      gateway as GatewayManager,
      { authOnly: true },
    );

    expect(gateway.rpc).toHaveBeenCalledWith('secrets.reload', {}, 30000);
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('uses secrets reload after deleting only provider api key when gateway is running', async () => {
    const gateway = createGateway('running');

    await syncDeletedProviderApiKeyToRuntime(
      createProvider(),
      'moonshot',
      undefined,
      gateway as GatewayManager,
    );

    expect(gateway.rpc).toHaveBeenCalledWith('secrets.reload', {}, 30000);
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('does not force a gateway refresh after switching default provider when gateway is running', async () => {
    const gateway = createGateway('running');
    await syncDefaultProviderToRuntime('moonshot', gateway as GatewayManager);

    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
    expect(gateway.rpc).not.toHaveBeenCalled();
  });

  it('registers standard provider models in agent models.json when switching the default provider', async () => {
    mocks.getProvider.mockResolvedValue(createProvider({
      id: 'deepseek-account',
      name: 'DeepSeek',
      type: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    }));
    mocks.getProviderConfig.mockReturnValue({
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    });
    mocks.getApiKey.mockResolvedValue('sk-deepseek');

    await syncDefaultProviderToRuntime('deepseek-account');

    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith('deepseek', {
      baseUrl: 'https://api.deepseek.com',
      api: 'openai-completions',
      apiKey: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }],
    });
  });

  it('skips refresh after switching default provider when gateway is stopped', async () => {
    const gateway = createGateway('stopped');
    await syncDefaultProviderToRuntime('moonshot', gateway as GatewayManager);

    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('normalizes legacy ollama model refs to the runtime provider key during startup sync', async () => {
    mocks.listProviderAccounts.mockResolvedValue([
      {
        id: 'ollama-ollamaad',
        vendorId: 'ollama',
        label: 'Ollama',
        authMode: 'local',
        baseUrl: 'http://localhost:8000/v1',
        model: 'qwen3.5-0.8b',
        enabled: true,
        isDefault: false,
        createdAt: '2026-04-12T00:00:00.000Z',
        updatedAt: '2026-04-12T00:00:00.000Z',
      },
    ]);
    mocks.getProviderSecret.mockResolvedValue({
      type: 'local',
      accountId: 'ollama-ollamaad',
      apiKey: 'ollama-local',
    });
    mocks.readOpenClawConfig.mockResolvedValue({
      agents: {
        defaults: {
          model: {
            primary: 'ollama/qwen3.5-0.8b',
            fallbacks: [],
          },
        },
        list: [
          {
            id: 'main',
            model: 'ollama/qwen3.5-0.8b',
          },
        ],
      },
    });

    const { syncAllProviderAuthToRuntime } = await import('@electron/services/providers/provider-runtime-sync');
    await syncAllProviderAuthToRuntime();

    expect(mocks.writeOpenClawConfig).toHaveBeenCalledWith(expect.objectContaining({
      agents: expect.objectContaining({
        defaults: expect.objectContaining({
          model: expect.objectContaining({
            primary: 'ollama-ollamaol/qwen3.5-0.8b',
          }),
        }),
        list: [
          expect.objectContaining({
            id: 'main',
            model: 'ollama-ollamaol/qwen3.5-0.8b',
          }),
        ],
      }),
    }));
  });

  it('syncs OpenAI-compatible provider config during startup auth sync', async () => {
    mocks.listProviderAccounts.mockResolvedValue([
      {
        id: 'openai-qwen35-9b-local',
        vendorId: 'openai',
        label: 'OpenAI-Compatible Qwen',
        authMode: 'api_key',
        baseUrl: 'http://10.101.80.18:8888/v1',
        apiProtocol: 'openai-completions',
        model: 'Qwen3.5-9B',
        enabled: true,
        isDefault: false,
        createdAt: '2026-04-20T10:08:02.575Z',
        updatedAt: '2026-04-20T10:08:02.575Z',
      },
    ]);
    mocks.getProviderSecret.mockResolvedValue({
      type: 'api_key',
      accountId: 'openai-qwen35-9b-local',
      apiKey: 'not-validated',
    });
    mocks.getProviderConfig.mockReturnValue({
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
    mocks.readOpenClawConfig.mockResolvedValue({
      agents: {
        list: [
          {
            id: 'main',
            model: 'openai/Qwen3.5-9B',
          },
        ],
      },
    });

    await syncAllProviderAuthToRuntime();

    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'openai',
      'Qwen3.5-9B',
      expect.objectContaining({
        baseUrl: 'http://10.101.80.18:8888/v1',
        api: 'openai-completions',
      }),
    );
    expect(mocks.saveProviderKeyToOpenClaw).toHaveBeenCalledWith('openai', 'not-validated');
  });
});
