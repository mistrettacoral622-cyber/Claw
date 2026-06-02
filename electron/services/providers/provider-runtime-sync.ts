import type { GatewayManager } from '../../gateway/manager';
import {
  classifyGatewayRefresh,
  type GatewayRefreshIntent,
} from '../../gateway/refresh-classifier';
import { getProviderAccount, listProviderAccounts, providerAccountToConfig } from './provider-store';
import { getProviderSecret } from '../secrets/secret-store';
import type { ProviderConfig } from '../../utils/secure-storage';
import { getAllProviders, getApiKey, getDefaultProvider, getProvider } from '../../utils/secure-storage';
import { getProviderConfig, getProviderDefaultModel } from '../../utils/provider-registry';
import { getProviderDefinition } from '../../shared/providers/registry';
import { readOpenClawConfig, writeOpenClawConfig } from '../../utils/channel-config';
import {
  removeProviderKeyFromOpenClaw,
  removeProviderFromOpenClaw,
  saveOAuthTokenToOpenClaw,
  saveProviderKeyToOpenClaw,
  setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride,
  syncProviderConfigToOpenClaw,
  updateAgentModelProvider,
} from '../../utils/openclaw-auth';
import { buildNonOAuthAgentProviderUpdate } from '../../main/provider-model-sync';
import { logger } from '../../utils/logger';

const GOOGLE_OAUTH_RUNTIME_PROVIDER = 'google-gemini-cli';
const GOOGLE_OAUTH_DEFAULT_MODEL_REF = `${GOOGLE_OAUTH_RUNTIME_PROVIDER}/gemini-3-pro-preview`;
const OPENAI_OAUTH_RUNTIME_PROVIDER = 'openai-codex';
const OPENAI_OAUTH_DEFAULT_MODEL_REF = `${OPENAI_OAUTH_RUNTIME_PROVIDER}/gpt-5.3-codex`;

type RuntimeProviderSyncContext = {
  runtimeProviderKey: string;
  meta: ReturnType<typeof getProviderConfig>;
  api: string;
};

function normalizeProviderBaseUrl(
  config: ProviderConfig,
  baseUrl?: string,
  apiProtocol?: string,
): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');

  if (config.type === 'minimax-portal' || config.type === 'minimax-portal-cn') {
    return normalized.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
  }

  if (config.type === 'custom' || config.type === 'ollama') {
    const protocol = apiProtocol || config.apiProtocol || 'openai-completions';
    if (protocol === 'openai-responses') {
      return normalized.replace(/\/responses?$/i, '');
    }
    if (protocol === 'openai-completions') {
      return normalized.replace(/\/chat\/completions$/i, '');
    }
    if (protocol === 'anthropic-messages') {
      return normalized.replace(/\/v1\/messages$/i, '').replace(/\/messages$/i, '');
    }
  }

  return normalized;
}

function shouldUseExplicitDefaultOverride(config: ProviderConfig, runtimeProviderKey: string): boolean {
  return Boolean(config.baseUrl || config.apiProtocol || runtimeProviderKey !== config.type);
}

export function getOpenClawProviderKey(type: string, providerId: string): string {
  if (type === 'custom' || type === 'ollama') {
    const suffix = providerId.replace(/-/g, '').slice(0, 8);
    return `${type}-${suffix}`;
  }
  if (type === 'minimax-portal-cn') {
    return 'minimax-portal';
  }
  return type;
}

async function resolveRuntimeProviderKey(config: ProviderConfig): Promise<string> {
  const account = await getProviderAccount(config.id);
  if (account?.authMode === 'oauth_browser') {
    if (config.type === 'google') {
      return GOOGLE_OAUTH_RUNTIME_PROVIDER;
    }
    if (config.type === 'openai') {
      return OPENAI_OAUTH_RUNTIME_PROVIDER;
    }
  }
  return getOpenClawProviderKey(config.type, config.id);
}

async function getBrowserOAuthRuntimeProvider(config: ProviderConfig): Promise<string | null> {
  const account = await getProviderAccount(config.id);
  if (account?.authMode !== 'oauth_browser') {
    return null;
  }

  const secret = await getProviderSecret(config.id);
  if (secret?.type !== 'oauth') {
    return null;
  }

  if (config.type === 'google') {
    return GOOGLE_OAUTH_RUNTIME_PROVIDER;
  }
  if (config.type === 'openai') {
    return OPENAI_OAUTH_RUNTIME_PROVIDER;
  }
  return null;
}

export function getProviderModelRef(config: ProviderConfig): string | undefined {
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  if (config.model) {
    return config.model.startsWith(`${providerKey}/`)
      ? config.model
      : `${providerKey}/${config.model}`;
  }

  const defaultModel = getProviderDefaultModel(config.type);
  if (!defaultModel) {
    return undefined;
  }

  return defaultModel.startsWith(`${providerKey}/`)
    ? defaultModel
    : `${providerKey}/${defaultModel}`;
}

export async function getProviderFallbackModelRefs(config: ProviderConfig): Promise<string[]> {
  const allProviders = await getAllProviders();
  const providerMap = new Map(allProviders.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const results: string[] = [];
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  for (const fallbackModel of config.fallbackModels ?? []) {
    const normalizedModel = fallbackModel.trim();
    if (!normalizedModel) continue;

    const modelRef = normalizedModel.startsWith(`${providerKey}/`)
      ? normalizedModel
      : `${providerKey}/${normalizedModel}`;

    if (seen.has(modelRef)) continue;
    seen.add(modelRef);
    results.push(modelRef);
  }

  for (const fallbackId of config.fallbackProviderIds ?? []) {
    if (!fallbackId || fallbackId === config.id) continue;

    const fallbackProvider = providerMap.get(fallbackId);
    if (!fallbackProvider) continue;

    const modelRef = getProviderModelRef(fallbackProvider);
    if (!modelRef || seen.has(modelRef)) continue;

    seen.add(modelRef);
    results.push(modelRef);
  }

  return results;
}

function scheduleGatewayRefresh(
  gatewayManager: GatewayManager | undefined,
  message: string,
  intent: GatewayRefreshIntent,
  options?: { delayMs?: number; onlyIfRunning?: boolean },
): void {
  if (!gatewayManager) {
    return;
  }

  if (options?.onlyIfRunning && gatewayManager.getStatus().state === 'stopped') {
    return;
  }

  const action = classifyGatewayRefresh(intent);
  logger.info(`${message} (action=${action})`);

  switch (action) {
    case 'restart':
      gatewayManager.debouncedRestart(options?.delayMs);
      return;
    case 'reload':
      gatewayManager.debouncedReload(options?.delayMs);
      return;
    case 'secrets_reload':
      if (gatewayManager.getStatus().state === 'stopped') {
        return;
      }
      void gatewayManager.rpc('secrets.reload', {}, 30000).catch((error) => {
        logger.warn('Gateway secrets.reload failed:', error);
      });
      return;
    case 'none':
    default:
      return;
  }
}

export async function syncProviderApiKeyToRuntime(
  providerType: string,
  providerId: string,
  apiKey: string,
): Promise<void> {
  const ock = getOpenClawProviderKey(providerType, providerId);
  await saveProviderKeyToOpenClaw(ock, apiKey);
}

export async function syncAllProviderAuthToRuntime(): Promise<void> {
  const accounts = await listProviderAccounts();

  for (const account of accounts) {
    await syncProviderToRuntime(providerAccountToConfig(account), undefined);
  }

  const defaultProviderId = await getDefaultProvider();
  if (defaultProviderId && accounts.some((account) => account.id === defaultProviderId)) {
    await syncDefaultProviderToRuntime(defaultProviderId);
  }

  await normalizeAgentModelRefsInOpenClawConfig();
}

async function syncProviderSecretToRuntime(
  config: ProviderConfig,
  runtimeProviderKey: string,
  apiKey: string | undefined,
): Promise<void> {
  const secret = await getProviderSecret(config.id);
  if (apiKey !== undefined) {
    const trimmedKey = apiKey.trim();
    if (trimmedKey) {
      await saveProviderKeyToOpenClaw(runtimeProviderKey, trimmedKey);
    }
    return;
  }

  if (secret?.type === 'api_key') {
    await saveProviderKeyToOpenClaw(runtimeProviderKey, secret.apiKey);
    return;
  }

  if (secret?.type === 'oauth') {
    await saveOAuthTokenToOpenClaw(runtimeProviderKey, {
      access: secret.accessToken,
      refresh: secret.refreshToken,
      expires: secret.expiresAt,
      email: secret.email,
      projectId: secret.subject,
    });
    return;
  }

  if (secret?.type === 'local' && secret.apiKey) {
    await saveProviderKeyToOpenClaw(runtimeProviderKey, secret.apiKey);
  }
}

function normalizeModelRefToRuntimeKey(
  modelRef: string | undefined,
  providerKeysByVendor: Map<string, string[]>,
): string | undefined {
  if (!modelRef) return modelRef;

  const trimmed = modelRef.trim();
  if (!trimmed) return modelRef;

  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex === -1) return modelRef;

  const vendorKey = trimmed.slice(0, separatorIndex);
  const modelId = trimmed.slice(separatorIndex + 1);
  const runtimeKeys = providerKeysByVendor.get(vendorKey) ?? [];
  if (runtimeKeys.length !== 1) return modelRef;

  const runtimeKey = runtimeKeys[0];
  if (!runtimeKey || runtimeKey === vendorKey) return modelRef;

  return `${runtimeKey}/${modelId}`;
}

async function normalizeAgentModelRefsInOpenClawConfig(): Promise<void> {
  const accounts = await listProviderAccounts();
  if (accounts.length === 0) return;

  const providerKeysByVendor = new Map<string, string[]>();
  for (const account of accounts) {
    const runtimeProviderKey = await resolveRuntimeProviderKey({
      id: account.id,
      name: account.label,
      type: account.vendorId,
      baseUrl: account.baseUrl,
      model: account.model,
      fallbackModels: account.fallbackModels,
      fallbackProviderIds: account.fallbackAccountIds,
      enabled: account.enabled,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });

    const existing = providerKeysByVendor.get(account.vendorId) ?? [];
    if (!existing.includes(runtimeProviderKey)) {
      existing.push(runtimeProviderKey);
      providerKeysByVendor.set(account.vendorId, existing);
    }
  }

  const config = await readOpenClawConfig();
  const agents = config.agents && typeof config.agents === 'object'
    ? config.agents as Record<string, unknown>
    : null;
  if (!agents) return;

  let modified = false;

  const defaults = agents.defaults && typeof agents.defaults === 'object'
    ? agents.defaults as Record<string, unknown>
    : null;
  if (defaults) {
    if (typeof defaults.model === 'string') {
      const normalized = normalizeModelRefToRuntimeKey(defaults.model, providerKeysByVendor);
      if (normalized && normalized !== defaults.model) {
        defaults.model = normalized;
        modified = true;
      }
    } else if (defaults.model && typeof defaults.model === 'object') {
      const modelConfig = defaults.model as Record<string, unknown>;
      if (typeof modelConfig.primary === 'string') {
        const normalized = normalizeModelRefToRuntimeKey(modelConfig.primary, providerKeysByVendor);
        if (normalized && normalized !== modelConfig.primary) {
          modelConfig.primary = normalized;
          modified = true;
        }
      }
      if (Array.isArray(modelConfig.fallbacks)) {
        const normalizedFallbacks = modelConfig.fallbacks.map((entry) =>
          typeof entry === 'string' ? normalizeModelRefToRuntimeKey(entry, providerKeysByVendor) ?? entry : entry);
        if (JSON.stringify(normalizedFallbacks) !== JSON.stringify(modelConfig.fallbacks)) {
          modelConfig.fallbacks = normalizedFallbacks;
          modified = true;
        }
      }
    }
  }

  const agentList = Array.isArray(agents.list) ? agents.list as Array<Record<string, unknown>> : [];
  for (const agent of agentList) {
    if (typeof agent.model !== 'string') continue;
    const normalized = normalizeModelRefToRuntimeKey(agent.model, providerKeysByVendor);
    if (normalized && normalized !== agent.model) {
      agent.model = normalized;
      modified = true;
    }
  }

  if (modified) {
    await writeOpenClawConfig(config);
  }
}

async function resolveRuntimeSyncContext(config: ProviderConfig): Promise<RuntimeProviderSyncContext | null> {
  const runtimeProviderKey = await resolveRuntimeProviderKey(config);
  const meta = getProviderConfig(config.type);
  const api = config.apiProtocol || (config.type === 'custom' ? 'openai-completions' : meta?.api);
  if (!api) {
    return null;
  }

  return {
    runtimeProviderKey,
    meta,
    api,
  };
}

async function syncRuntimeProviderConfig(
  config: ProviderConfig,
  context: RuntimeProviderSyncContext,
): Promise<void> {
  await syncProviderConfigToOpenClaw(context.runtimeProviderKey, config.model, {
    baseUrl: normalizeProviderBaseUrl(config, config.baseUrl || context.meta?.baseUrl, context.api),
    api: context.api,
    apiKeyEnv: context.meta?.apiKeyEnv,
    headers: context.meta?.headers,
  });
}

async function syncCustomProviderAgentModel(
  config: ProviderConfig,
  runtimeProviderKey: string,
  apiKey: string | undefined,
): Promise<void> {
  if (config.type !== 'custom') {
    return;
  }

  const resolvedKey = apiKey !== undefined ? (apiKey.trim() || null) : await getApiKey(config.id);
  if (!resolvedKey || !config.baseUrl) {
    return;
  }

  const modelId = config.model;
  await updateAgentModelProvider(runtimeProviderKey, {
    baseUrl: normalizeProviderBaseUrl(config, config.baseUrl, config.apiProtocol || 'openai-completions'),
    api: config.apiProtocol || 'openai-completions',
    models: modelId ? [{ id: modelId, name: modelId }] : [],
    apiKey: resolvedKey,
  });
}

async function syncStandardProviderAgentModel(
  config: ProviderConfig,
): Promise<void> {
  const payload = buildNonOAuthAgentProviderUpdate(config, config.id, getProviderModelRef(config));
  if (!payload) {
    return;
  }

  await updateAgentModelProvider(payload.providerKey, payload.entry);
}

async function syncProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
): Promise<RuntimeProviderSyncContext | null> {
  const context = await resolveRuntimeSyncContext(config);
  if (!context) {
    return null;
  }

  await syncProviderSecretToRuntime(config, context.runtimeProviderKey, apiKey);
  await syncRuntimeProviderConfig(config, context);
  await syncStandardProviderAgentModel(config);
  await syncCustomProviderAgentModel(config, context.runtimeProviderKey, apiKey);
  return context;
}

export async function syncSavedProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
  gatewayManager?: GatewayManager,
): Promise<void> {
  const context = await syncProviderToRuntime(config, apiKey);
  if (!context) {
    return;
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Applying Gateway refresh policy after saving provider "${context.runtimeProviderKey}" config`,
    { kind: 'provider', event: 'saved' },
  );
}

export async function syncUpdatedProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
  gatewayManager?: GatewayManager,
  options?: { authOnly?: boolean },
): Promise<void> {
  const context = await syncProviderToRuntime(config, apiKey);
  if (!context) {
    return;
  }

  const ock = context.runtimeProviderKey;
  const fallbackModels = await getProviderFallbackModelRefs(config);

  const defaultProviderId = await getDefaultProvider();
  if (defaultProviderId === config.id) {
    const modelOverride = config.model ? `${ock}/${config.model}` : undefined;
    if (config.type !== 'custom') {
      if (shouldUseExplicitDefaultOverride(config, ock)) {
        await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
          baseUrl: normalizeProviderBaseUrl(config, config.baseUrl || context.meta?.baseUrl, context.api),
          api: context.api,
          apiKeyEnv: context.meta?.apiKeyEnv,
          headers: context.meta?.headers,
        }, fallbackModels);
      } else {
        await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
      }
    } else {
      await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
        baseUrl: normalizeProviderBaseUrl(config, config.baseUrl, config.apiProtocol || 'openai-completions'),
        api: config.apiProtocol || 'openai-completions',
      }, fallbackModels);
    }
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Applying Gateway refresh policy after updating provider "${ock}" config`,
    { kind: 'provider', event: options?.authOnly ? 'auth_changed' : 'updated' },
  );
}

export async function syncDeletedProviderToRuntime(
  provider: ProviderConfig | null,
  providerId: string,
  gatewayManager?: GatewayManager,
  runtimeProviderKey?: string,
): Promise<void> {
  if (!provider?.type) {
    return;
  }

  const ock = runtimeProviderKey ?? await resolveRuntimeProviderKey({ ...provider, id: providerId });
  await removeProviderFromOpenClaw(ock);

  scheduleGatewayRefresh(
    gatewayManager,
    `Applying Gateway refresh policy after deleting provider "${ock}"`,
    { kind: 'provider', event: 'deleted' },
  );
}

export async function syncDeletedProviderApiKeyToRuntime(
  provider: ProviderConfig | null,
  providerId: string,
  runtimeProviderKey?: string,
  gatewayManager?: GatewayManager,
): Promise<void> {
  const ock = runtimeProviderKey
    ?? (provider?.type ? await resolveRuntimeProviderKey({ ...provider, id: providerId }) : null);
  if (!ock) {
    return;
  }

  await removeProviderKeyFromOpenClaw(ock);
  scheduleGatewayRefresh(
    gatewayManager,
    `Applying Gateway refresh policy after deleting provider api key for "${ock}"`,
    { kind: 'provider', event: 'auth_changed' },
    { onlyIfRunning: true },
  );
}

export async function syncDefaultProviderToRuntime(
  providerId: string,
  gatewayManager?: GatewayManager,
): Promise<void> {
  const provider = await getProvider(providerId);
  if (!provider) {
    return;
  }
  if (getProviderDefinition(provider.type)?.supportsChat === false) {
    logger.warn(`Skipping default model sync for non-chat provider "${provider.type}"`);
    return;
  }

  const ock = await resolveRuntimeProviderKey(provider);
  const providerKey = await getApiKey(providerId);
  const fallbackModels = await getProviderFallbackModelRefs(provider);
  const oauthTypes = ['qwen-portal', 'minimax-portal', 'minimax-portal-cn'];
  const browserOAuthRuntimeProvider = await getBrowserOAuthRuntimeProvider(provider);
  const isOAuthProvider = (oauthTypes.includes(provider.type) && !providerKey) || Boolean(browserOAuthRuntimeProvider);

  if (!isOAuthProvider) {
    const modelOverride = provider.model
      ? (provider.model.startsWith(`${ock}/`) ? provider.model : `${ock}/${provider.model}`)
      : undefined;

    if (provider.type === 'custom') {
      await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
        baseUrl: normalizeProviderBaseUrl(provider, provider.baseUrl, provider.apiProtocol || 'openai-completions'),
        api: provider.apiProtocol || 'openai-completions',
      }, fallbackModels);
    } else if (shouldUseExplicitDefaultOverride(provider, ock)) {
      await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
        baseUrl: normalizeProviderBaseUrl(
          provider,
          provider.baseUrl || getProviderConfig(provider.type)?.baseUrl,
          provider.apiProtocol || getProviderConfig(provider.type)?.api,
        ),
        api: provider.apiProtocol || getProviderConfig(provider.type)?.api,
        apiKeyEnv: getProviderConfig(provider.type)?.apiKeyEnv,
        headers: getProviderConfig(provider.type)?.headers,
      }, fallbackModels);
    } else {
      await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
    }

    if (providerKey) {
      await saveProviderKeyToOpenClaw(ock, providerKey);
    }

    await syncStandardProviderAgentModel(provider);
  } else {
    if (browserOAuthRuntimeProvider) {
      const secret = await getProviderSecret(provider.id);
      if (secret?.type === 'oauth') {
        await saveOAuthTokenToOpenClaw(browserOAuthRuntimeProvider, {
          access: secret.accessToken,
          refresh: secret.refreshToken,
          expires: secret.expiresAt,
          email: secret.email,
          projectId: secret.subject,
        });
      }

      const defaultModelRef = browserOAuthRuntimeProvider === GOOGLE_OAUTH_RUNTIME_PROVIDER
        ? GOOGLE_OAUTH_DEFAULT_MODEL_REF
        : OPENAI_OAUTH_DEFAULT_MODEL_REF;
      const modelOverride = provider.model
        ? (provider.model.startsWith(`${browserOAuthRuntimeProvider}/`)
          ? provider.model
          : `${browserOAuthRuntimeProvider}/${provider.model}`)
        : defaultModelRef;

      await setOpenClawDefaultModel(browserOAuthRuntimeProvider, modelOverride, fallbackModels);
      logger.info(`Configured openclaw.json for browser OAuth provider "${provider.id}"`);
      scheduleGatewayRefresh(
        gatewayManager,
        `Applying Gateway refresh policy after provider switch to "${browserOAuthRuntimeProvider}"`,
        { kind: 'provider', event: 'default_changed' },
      );
      return;
    }

    const defaultBaseUrl = provider.type === 'minimax-portal'
      ? 'https://api.minimax.io/anthropic'
      : (provider.type === 'minimax-portal-cn' ? 'https://api.minimaxi.com/anthropic' : 'https://portal.qwen.ai/v1');
    const api: 'anthropic-messages' | 'openai-completions' =
      (provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn')
        ? 'anthropic-messages'
        : 'openai-completions';

    let baseUrl = provider.baseUrl || defaultBaseUrl;
    if ((provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn') && baseUrl) {
      baseUrl = baseUrl.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
    }

    const targetProviderKey = (provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn')
      ? 'minimax-portal'
      : provider.type;

    await setOpenClawDefaultModelWithOverride(targetProviderKey, getProviderModelRef(provider), {
      baseUrl,
      api,
      authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
      apiKeyEnv: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
    }, fallbackModels);

    logger.info(`Configured openclaw.json for OAuth provider "${provider.type}"`);

    try {
      const defaultModelId = provider.model?.split('/').pop();
      await updateAgentModelProvider(targetProviderKey, {
        baseUrl,
        api,
        authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
        apiKey: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
        models: defaultModelId ? [{ id: defaultModelId, name: defaultModelId }] : [],
      });
    } catch (err) {
      logger.warn(`Failed to update models.json for OAuth provider "${targetProviderKey}":`, err);
    }
  }

  if (
    provider.type === 'custom' &&
    providerKey &&
    provider.baseUrl
  ) {
    const modelId = provider.model;
    await updateAgentModelProvider(ock, {
      baseUrl: normalizeProviderBaseUrl(provider, provider.baseUrl, provider.apiProtocol || 'openai-completions'),
      api: provider.apiProtocol || 'openai-completions',
      models: modelId ? [{ id: modelId, name: modelId }] : [],
      apiKey: providerKey,
    });
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Applying Gateway refresh policy after provider switch to "${ock}"`,
    { kind: 'provider', event: 'default_changed' },
    { onlyIfRunning: true },
  );
}
