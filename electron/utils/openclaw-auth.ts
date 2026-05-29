/**
 * OpenClaw Auth Profiles Utility
 * Writes API keys to configured OpenClaw agent auth-profiles.json files
 * so the OpenClaw Gateway can load them for AI provider calls.
 *
 * All file I/O is asynchronous (fs/promises) to avoid blocking the
 * Electron main thread.  On Windows + NTFS + Defender the synchronous
 * equivalents could stall for 500 ms – 2 s+ per call, causing "Not
 * Responding" hangs.
 */
import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { randomBytes } from 'node:crypto';
import { listConfiguredAgentIds } from './agent-config';
import {
  getProviderEnvVar,
  getProviderDefaultModel,
  getProviderConfig,
} from './provider-registry';
import {
  OPENCLAW_PROVIDER_KEY_MOONSHOT,
  isOAuthProviderType,
  isOpenClawOAuthPluginProviderKey,
} from './provider-keys';
import { OPENCLAW_WECHAT_CHANNEL_TYPE } from './channel-alias';
import { isActiveConfiguredChannelSection } from './channel-config';
import { withConfigLock } from './config-mutex';
import { logger } from './logger';
import { getOpenClawConfigDir } from './paths';
import { modelLooksVisionCapable } from '../../shared/chat-dispatch-hints';

const AUTH_STORE_VERSION = 1;
const AUTH_PROFILE_FILENAME = 'auth-profiles.json';

function getOAuthPluginId(provider: string): string {
  return `${provider}-auth`;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Non-throwing async existence check (replaces existsSync). */
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Ensure a directory exists (replaces mkdirSync). */
async function ensureDir(dir: string): Promise<void> {
  if (!(await fileExists(dir))) {
    await mkdir(dir, { recursive: true });
  }
}

/** Read a JSON file, returning `null` on any error. */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!(await fileExists(filePath))) return null;
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Write a JSON file, creating parent directories if needed. */
async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(join(filePath, '..'));
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Types ────────────────────────────────────────────────────────

interface AuthProfileEntry {
  type: 'api_key';
  provider: string;
  key: string;
}

interface OAuthProfileEntry {
  type: 'oauth';
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId?: string;
}

interface AuthProfilesStore {
  version: number;
  profiles: Record<string, AuthProfileEntry | OAuthProfileEntry>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
}

// ── Auth Profiles I/O ────────────────────────────────────────────

function getAuthProfilesPath(agentId = 'main'): string {
  return join(getOpenClawConfigDir(), 'agents', agentId, 'agent', AUTH_PROFILE_FILENAME);
}

async function readAuthProfiles(agentId = 'main'): Promise<AuthProfilesStore> {
  const filePath = getAuthProfilesPath(agentId);
  try {
    const data = await readJsonFile<AuthProfilesStore>(filePath);
    if (data?.version && data.profiles && typeof data.profiles === 'object') {
      return data;
    }
  } catch (error) {
    logger.warn('Failed to read auth-profiles.json, creating fresh store:', error);
  }
  return { version: AUTH_STORE_VERSION, profiles: {} };
}

async function writeAuthProfiles(store: AuthProfilesStore, agentId = 'main'): Promise<void> {
  await writeJsonFile(getAuthProfilesPath(agentId), store);
}

// ── Agent Discovery ──────────────────────────────────────────────

async function discoverAgentIds(): Promise<string[]> {
  const agentsDir = join(getOpenClawConfigDir(), 'agents');
  try {
    if (!(await fileExists(agentsDir))) return ['main'];
    return await listConfiguredAgentIds();
  } catch {
    return ['main'];
  }
}

// ── OpenClaw Config Helpers ──────────────────────────────────────

const OPENCLAW_CONFIG_PATH = join(getOpenClawConfigDir(), 'openclaw.json');
const VALID_COMPACTION_MODES = new Set(['default', 'safeguard']);

async function readOpenClawJson(): Promise<Record<string, unknown>> {
  return (await readJsonFile<Record<string, unknown>>(OPENCLAW_CONFIG_PATH)) ?? {};
}

function normalizeAgentsDefaultsCompactionMode(config: Record<string, unknown>): void {
  const agents = (config.agents && typeof config.agents === 'object'
    ? config.agents as Record<string, unknown>
    : null);
  if (!agents) return;

  const defaults = (agents.defaults && typeof agents.defaults === 'object'
    ? agents.defaults as Record<string, unknown>
    : null);
  if (!defaults) return;

  const compaction = (defaults.compaction && typeof defaults.compaction === 'object'
    ? defaults.compaction as Record<string, unknown>
    : null);
  if (!compaction) return;

  const mode = compaction.mode;
  if (typeof mode === 'string' && mode.length > 0 && !VALID_COMPACTION_MODES.has(mode)) {
    compaction.mode = 'default';
  }
}

async function writeOpenClawJson(config: Record<string, unknown>): Promise<void> {
  normalizeAgentsDefaultsCompactionMode(config);

  // Ensure SIGUSR1 graceful reload is authorized by OpenClaw config.
  const commands = (
    config.commands && typeof config.commands === 'object'
      ? { ...(config.commands as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  commands.restart = true;
  config.commands = commands;

  await writeJsonFile(OPENCLAW_CONFIG_PATH, config);
}

// ── Exported Functions (all async) ───────────────────────────────

/**
 * Save an OAuth token to OpenClaw's auth-profiles.json.
 */
export async function saveOAuthTokenToOpenClaw(
  provider: string,
  token: { access: string; refresh: string; expires: number; email?: string; projectId?: string },
  agentId?: string
): Promise<void> {
  const agentIds = agentId ? [agentId] : await discoverAgentIds();
  if (agentIds.length === 0) agentIds.push('main');

  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
    const profileId = `${provider}:default`;

    store.profiles[profileId] = {
      type: 'oauth',
      provider,
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
      email: token.email,
      projectId: token.projectId,
    };

    if (!store.order) store.order = {};
    if (!store.order[provider]) store.order[provider] = [];
    if (!store.order[provider].includes(profileId)) {
      store.order[provider].push(profileId);
    }

    if (!store.lastGood) store.lastGood = {};
    store.lastGood[provider] = profileId;

    await writeAuthProfiles(store, id);
  }
  logger.info(`Saved OAuth token for provider "${provider}" to OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
}

/**
 * Retrieve an OAuth token from OpenClaw's auth-profiles.json.
 * Useful when the Gateway does not natively inject the Authorization header.
 * 
 * @param provider - Provider type (e.g., 'minimax-portal')
 * @param agentId - Optional single agent ID to read from, defaults to 'main'
 * @returns The OAuth token access string or null if not found
 */
export async function getOAuthTokenFromOpenClaw(
  provider: string,
  agentId = 'main'
): Promise<string | null> {
  try {
    const store = await readAuthProfiles(agentId);
    const profileId = `${provider}:default`;
    const profile = store.profiles[profileId];

    if (profile && profile.type === 'oauth' && 'access' in profile) {
      return (profile as OAuthProfileEntry).access;
    }
  } catch (err) {
    logger.warn(`[getOAuthToken] Failed to read token for ${provider}:`, err);
  }
  return null;
}

/**
 * Save a provider API key to OpenClaw's auth-profiles.json
 */
export async function saveProviderKeyToOpenClaw(
  provider: string,
  apiKey: string,
  agentId?: string
): Promise<void> {
  if (isOAuthProviderType(provider) && !apiKey) {
    logger.info(`Skipping auth-profiles write for OAuth provider "${provider}" (no API key provided, using OAuth)`);
    return;
  }
  const agentIds = agentId ? [agentId] : await discoverAgentIds();
  if (agentIds.length === 0) agentIds.push('main');

  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
    const profileId = `${provider}:default`;

    store.profiles[profileId] = { type: 'api_key', provider, key: apiKey };

    if (!store.order) store.order = {};
    if (!store.order[provider]) store.order[provider] = [];
    if (!store.order[provider].includes(profileId)) {
      store.order[provider].push(profileId);
    }

    if (!store.lastGood) store.lastGood = {};
    store.lastGood[provider] = profileId;

    await writeAuthProfiles(store, id);
  }
  logger.info(`Saved API key for provider "${provider}" to OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
}

/**
 * Remove a provider API key from OpenClaw auth-profiles.json
 */
export async function removeProviderKeyFromOpenClaw(
  provider: string,
  agentId?: string
): Promise<void> {
  if (isOAuthProviderType(provider)) {
    logger.info(`Skipping auth-profiles removal for OAuth provider "${provider}" (managed by OpenClaw plugin)`);
    return;
  }
  const agentIds = agentId ? [agentId] : await discoverAgentIds();
  if (agentIds.length === 0) agentIds.push('main');

  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
    const profileId = `${provider}:default`;

    delete store.profiles[profileId];

    if (store.order?.[provider]) {
      store.order[provider] = store.order[provider].filter((aid) => aid !== profileId);
      if (store.order[provider].length === 0) delete store.order[provider];
    }
    if (store.lastGood?.[provider] === profileId) delete store.lastGood[provider];

    await writeAuthProfiles(store, id);
  }
  logger.info(`Removed API key for provider "${provider}" from OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
}

/**
 * Remove a provider completely from OpenClaw (delete config, disable plugins, delete keys)
 */
export async function removeProviderFromOpenClaw(provider: string): Promise<void> {
  // 1. Remove from auth-profiles.json
  const agentIds = await discoverAgentIds();
  if (agentIds.length === 0) agentIds.push('main');
  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) {
      delete store.profiles[profileId];
      if (store.order?.[provider]) {
        store.order[provider] = store.order[provider].filter((aid) => aid !== profileId);
        if (store.order[provider].length === 0) delete store.order[provider];
      }
      if (store.lastGood?.[provider] === profileId) delete store.lastGood[provider];
      await writeAuthProfiles(store, id);
    }
  }

  // 2. Remove from models.json (per-agent model registry used by pi-ai directly)
  for (const id of agentIds) {
    const modelsPath = join(getOpenClawConfigDir(), 'agents', id, 'agent', 'models.json');
    try {
      if (await fileExists(modelsPath)) {
        const raw = await readFile(modelsPath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        const providers = data.providers as Record<string, unknown> | undefined;
        if (providers && providers[provider]) {
          delete providers[provider];
          await writeFile(modelsPath, JSON.stringify(data, null, 2), 'utf-8');
          logger.info(`Removed models.json entry for provider "${provider}" (agent "${id}")`);
        }
      }
    } catch (err) {
      logger.warn(`Failed to remove provider ${provider} from models.json (agent "${id}"):`, err);
    }
  }

  // 3. Remove from openclaw.json
  try {
    await withConfigLock(async () => {
      const config = await readOpenClawJson();
      let modified = false;

      // Disable plugin (for OAuth like qwen-portal-auth)
      const plugins = config.plugins as Record<string, unknown> | undefined;
      const entries = (plugins?.entries ?? {}) as Record<string, Record<string, unknown>>;
      const pluginName = `${provider}-auth`;
      if (entries[pluginName]) {
        entries[pluginName].enabled = false;
        modified = true;
        logger.info(`Disabled OpenClaw plugin: ${pluginName}`);
      }

      // Remove from models.providers
      const models = config.models as Record<string, unknown> | undefined;
      const providers = (models?.providers ?? {}) as Record<string, unknown>;
      if (providers[provider]) {
        delete providers[provider];
        modified = true;
        logger.info(`Removed OpenClaw provider config: ${provider}`);
      }

      if (modified) {
        await writeOpenClawJson(config);
      }
    });
  } catch (err) {
    logger.warn(`Failed to remove provider ${provider} from openclaw.json:`, err);
  }
}

/**
 * Build environment variables object with all stored API keys
 * for passing to the Gateway process
 */
export function buildProviderEnvVars(providers: Array<{ type: string; apiKey: string }>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { type, apiKey } of providers) {
    const envVar = getProviderEnvVar(type);
    if (envVar && apiKey) {
      env[envVar] = apiKey;
    }
  }
  return env;
}

/**
 * Update the OpenClaw config to use the given provider and model
 * Writes to ~/.openclaw/openclaw.json
 */
export async function setOpenClawDefaultModel(
  provider: string,
  modelOverride?: string,
  fallbackModels: string[] = []
): Promise<void> {
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    ensureMoonshotKimiWebSearchCnBaseUrl(config, provider);

    const model = normalizeModelRef(provider, modelOverride);
    if (!model) {
      logger.warn(`No default model mapping for provider "${provider}"`);
      return;
    }

    const modelId = extractModelId(provider, model);
    const fallbackModelIds = extractFallbackModelIds(provider, fallbackModels);

    // Set the default model for the agents
    const agents = (config.agents || {}) as Record<string, unknown>;
    const defaults = (agents.defaults || {}) as Record<string, unknown>;
    defaults.model = {
      primary: model,
      fallbacks: fallbackModels,
    };
    agents.defaults = defaults;
    config.agents = agents;

    // Configure models.providers for providers that need explicit registration.
    const providerCfg = getProviderConfig(provider);
    if (providerCfg) {
      upsertOpenClawProviderEntry(config, provider, {
        baseUrl: providerCfg.baseUrl,
        api: providerCfg.api,
        apiKeyEnv: providerCfg.apiKeyEnv,
        headers: providerCfg.headers,
        modelIds: [modelId, ...fallbackModelIds],
        includeRegistryModels: true,
        mergeExistingModels: true,
      });
      logger.info(`Configured models.providers.${provider} with baseUrl=${providerCfg.baseUrl}, model=${modelId}`);
    } else {
      // Built-in provider: remove any stale models.providers entry
      const models = (config.models || {}) as Record<string, unknown>;
      const providers = (models.providers || {}) as Record<string, unknown>;
      if (providers[provider]) {
        delete providers[provider];
        logger.info(`Removed stale models.providers.${provider} (built-in provider)`);
        models.providers = providers;
        config.models = models;
      }
    }

    // Ensure gateway mode is set
    const gateway = (config.gateway || {}) as Record<string, unknown>;
    if (!gateway.mode) gateway.mode = 'local';
    config.gateway = gateway;

    await writeOpenClawJson(config);
    logger.info(`Set OpenClaw default model to "${model}" for provider "${provider}"`);
  });
}

interface RuntimeProviderConfigOverride {
  baseUrl?: string;
  api?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

type A2APluginOutboundAgentEntry = {
  url: string;
  custom_headers?: Record<string, string>;
};

type A2APluginOutboundConfig = {
  agents: Record<string, A2APluginOutboundAgentEntry>;
};

export type A2AInboundAgentCardSkill = {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
};

export type A2AInboundAgentCardConfig = {
  name?: string;
  description?: string;
  skills?: A2AInboundAgentCardSkill[];
};

export type A2AInboundApiKeyConfig = {
  label: string;
  key: string;
};

export type A2APluginInboundConfig = {
  agentCard?: A2AInboundAgentCardConfig;
  allowUnauthenticated?: boolean;
  apiKeys?: A2AInboundApiKeyConfig[];
};

export type A2APluginConfigSnapshot = {
  enabled: boolean;
  inbound: A2APluginInboundConfig;
  outbound: A2APluginOutboundConfig;
};

export type A2AInboundConfigPatch = {
  enabled?: boolean;
  agentCard?: A2AInboundAgentCardConfig;
  allowUnauthenticated?: boolean;
};

export type OpenClawGatewayBindMode = 'loopback' | 'lan' | 'tailnet' | 'auto' | 'custom';

export type OpenClawGatewayExposureConfigSnapshot = {
  bindMode: OpenClawGatewayBindMode;
  customBindHost?: string;
  tailscaleMode: 'off' | 'serve' | 'funnel' | string;
};

export type OpenClawGatewayExposureConfigPatch = {
  bindMode?: OpenClawGatewayBindMode;
};

type ProviderEntryBuildOptions = {
  baseUrl: string;
  api: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  modelIds?: string[];
  includeRegistryModels?: boolean;
  mergeExistingModels?: boolean;
};

function normalizeModelRef(provider: string, modelOverride?: string): string | undefined {
  const rawModel = modelOverride || getProviderDefaultModel(provider);
  if (!rawModel) return undefined;
  return rawModel.startsWith(`${provider}/`) ? rawModel : `${provider}/${rawModel}`;
}

function extractModelId(provider: string, modelRef: string): string {
  return modelRef.startsWith(`${provider}/`) ? modelRef.slice(provider.length + 1) : modelRef;
}

function extractFallbackModelIds(provider: string, fallbackModels: string[]): string[] {
  return fallbackModels
    .filter((fallback) => fallback.startsWith(`${provider}/`))
    .map((fallback) => fallback.slice(provider.length + 1));
}

function ensurePluginEnabled(
  config: Record<string, unknown>,
  pluginId: string,
): Record<string, unknown> {
  const plugins = (config.plugins || {}) as Record<string, unknown>;
  const allow = Array.isArray(plugins.allow) ? [...plugins.allow as string[]] : [];
  const pEntries = (
    plugins.entries && typeof plugins.entries === 'object'
      ? { ...(plugins.entries as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  if (!allow.includes(pluginId)) {
    allow.push(pluginId);
  }

  const currentEntry = (pEntries[pluginId] && typeof pEntries[pluginId] === 'object')
    ? { ...(pEntries[pluginId] as Record<string, unknown>) }
    : {};
  currentEntry.enabled = true;
  pEntries[pluginId] = currentEntry;

  plugins.allow = allow;
  plugins.entries = pEntries;
  config.plugins = plugins;
  return currentEntry;
}

function readPluginEntry(
  config: Record<string, unknown>,
  pluginId: string,
): Record<string, unknown> | null {
  const plugins = config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
    ? config.plugins as Record<string, unknown>
    : null;
  const entries = plugins?.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
    ? plugins.entries as Record<string, unknown>
    : null;
  const entry = entries?.[pluginId];
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : null;
}

function setPluginEnabled(
  config: Record<string, unknown>,
  pluginId: string,
  enabled: boolean,
): Record<string, unknown> {
  if (enabled) {
    return ensurePluginEnabled(config, pluginId);
  }

  const plugins = (
    config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? { ...(config.plugins as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const allow = Array.isArray(plugins.allow)
    ? (plugins.allow as unknown[]).filter((value): value is string => typeof value === 'string' && value !== pluginId)
    : [];
  const entries = (
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? { ...(plugins.entries as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const currentEntry = entries[pluginId] && typeof entries[pluginId] === 'object' && !Array.isArray(entries[pluginId])
    ? { ...(entries[pluginId] as Record<string, unknown>) }
    : {};

  currentEntry.enabled = false;
  entries[pluginId] = currentEntry;
  plugins.allow = allow;
  plugins.entries = entries;
  config.plugins = plugins;
  return currentEntry;
}

function normalizeOptionalConfigString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeConfigStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((entry) => normalizeOptionalConfigString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return items.length > 0 ? items : undefined;
}

function normalizeA2AInboundSkill(value: unknown): A2AInboundAgentCardSkill | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const id = normalizeOptionalConfigString(raw.id);
  const name = normalizeOptionalConfigString(raw.name);
  const description = normalizeOptionalConfigString(raw.description);
  if (!id || !name || !description) {
    return null;
  }

  return {
    id,
    name,
    description,
    ...(normalizeConfigStringArray(raw.tags) ? { tags: normalizeConfigStringArray(raw.tags) } : {}),
    ...(normalizeConfigStringArray(raw.examples) ? { examples: normalizeConfigStringArray(raw.examples) } : {}),
    ...(normalizeConfigStringArray(raw.inputModes) ? { inputModes: normalizeConfigStringArray(raw.inputModes) } : {}),
    ...(normalizeConfigStringArray(raw.outputModes) ? { outputModes: normalizeConfigStringArray(raw.outputModes) } : {}),
  };
}

function normalizeA2AInboundAgentCard(value: unknown): A2AInboundAgentCardConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const skills = Array.isArray(raw.skills)
    ? raw.skills.map(normalizeA2AInboundSkill).filter((entry): entry is A2AInboundAgentCardSkill => entry !== null)
    : undefined;
  const card: A2AInboundAgentCardConfig = {
    ...(normalizeOptionalConfigString(raw.name) ? { name: normalizeOptionalConfigString(raw.name) } : {}),
    ...(normalizeOptionalConfigString(raw.description) ? { description: normalizeOptionalConfigString(raw.description) } : {}),
    ...(skills && skills.length > 0 ? { skills } : {}),
  };

  return Object.keys(card).length > 0 ? card : undefined;
}

function normalizeA2AInboundApiKey(value: unknown): A2AInboundApiKeyConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const label = normalizeOptionalConfigString(raw.label);
  const key = normalizeOptionalConfigString(raw.key);
  return label && key ? { label, key } : null;
}

function normalizeA2AInboundConfig(value: unknown): A2APluginInboundConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const agentCard = normalizeA2AInboundAgentCard(raw.agentCard);
  const apiKeys = Array.isArray(raw.apiKeys)
    ? raw.apiKeys.map(normalizeA2AInboundApiKey).filter((entry): entry is A2AInboundApiKeyConfig => entry !== null)
    : undefined;

  return {
    ...(agentCard ? { agentCard } : {}),
    ...(typeof raw.allowUnauthenticated === 'boolean' ? { allowUnauthenticated: raw.allowUnauthenticated } : {}),
    ...(apiKeys && apiKeys.length > 0 ? { apiKeys } : {}),
  };
}

function normalizeA2AOutboundConfig(value: unknown): A2APluginOutboundConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { agents: {} };
  }

  const raw = value as Record<string, unknown>;
  const rawAgents = raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents)
    ? raw.agents as Record<string, unknown>
    : {};
  const agents: Record<string, A2APluginOutboundAgentEntry> = {};

  for (const [agentId, rawAgent] of Object.entries(rawAgents)) {
    if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) {
      continue;
    }

    const rawEntry = rawAgent as Record<string, unknown>;
    const url = normalizeOptionalConfigString(rawEntry.url);
    if (!url) {
      continue;
    }

    const customHeaders = rawEntry.custom_headers && typeof rawEntry.custom_headers === 'object' && !Array.isArray(rawEntry.custom_headers)
      ? Object.fromEntries(
        Object.entries(rawEntry.custom_headers as Record<string, unknown>)
          .map(([key, value]) => [key.trim(), normalizeOptionalConfigString(value)])
          .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
      )
      : undefined;

    agents[agentId] = {
      url,
      ...(customHeaders && Object.keys(customHeaders).length > 0 ? { custom_headers: customHeaders } : {}),
    };
  }

  return { agents };
}

function readA2APluginConfigFromEntry(entry: Record<string, unknown> | null): A2APluginConfigSnapshot {
  const pluginConfig = entry?.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
    ? entry.config as Record<string, unknown>
    : {};

  return {
    enabled: entry?.enabled === true,
    inbound: normalizeA2AInboundConfig(pluginConfig.inbound),
    outbound: normalizeA2AOutboundConfig(pluginConfig.outbound),
  };
}

function mergeA2AInboundConfig(
  current: A2APluginInboundConfig,
  patch: A2AInboundConfigPatch,
): A2APluginInboundConfig {
  const next: A2APluginInboundConfig = {
    ...current,
    ...(current.agentCard ? { agentCard: { ...current.agentCard } } : {}),
    ...(current.apiKeys ? { apiKeys: [...current.apiKeys] } : {}),
  };

  if (patch.agentCard) {
    const nextCard: A2AInboundAgentCardConfig = {
      ...(next.agentCard ?? {}),
    };
    if (patch.agentCard.name !== undefined) {
      const name = normalizeOptionalConfigString(patch.agentCard.name);
      if (name) {
        nextCard.name = name;
      } else {
        delete nextCard.name;
      }
    }
    if (patch.agentCard.description !== undefined) {
      const description = normalizeOptionalConfigString(patch.agentCard.description);
      if (description) {
        nextCard.description = description;
      } else {
        delete nextCard.description;
      }
    }
    if (patch.agentCard.skills !== undefined) {
      const skills = patch.agentCard.skills
        .map(normalizeA2AInboundSkill)
        .filter((entry): entry is A2AInboundAgentCardSkill => entry !== null);
      if (skills.length > 0) {
        nextCard.skills = skills;
      } else {
        delete nextCard.skills;
      }
    }
    if (Object.keys(nextCard).length > 0) {
      next.agentCard = nextCard;
    } else {
      delete next.agentCard;
    }
  }

  if (patch.allowUnauthenticated !== undefined) {
    next.allowUnauthenticated = Boolean(patch.allowUnauthenticated);
  }

  return next;
}

function generateA2AInboundAccessKey(): string {
  return `ktclaw_a2a_${randomBytes(32).toString('base64url')}`;
}

function normalizeA2AInboundKeyLabel(value: unknown): string {
  const label = normalizeOptionalConfigString(value);
  if (!label) {
    throw new Error('label is required');
  }
  if (label.length > 80) {
    throw new Error('label must be 80 characters or fewer');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/.test(label)) {
    throw new Error('label may contain letters, numbers, spaces, dots, underscores, and hyphens');
  }
  return label;
}

const OPENCLAW_GATEWAY_BIND_MODES: OpenClawGatewayBindMode[] = [
  'loopback',
  'lan',
  'tailnet',
  'auto',
  'custom',
];

function normalizeGatewayBindMode(value: unknown): OpenClawGatewayBindMode {
  const normalized = normalizeOptionalConfigString(value)?.toLowerCase();
  if (OPENCLAW_GATEWAY_BIND_MODES.includes(normalized as OpenClawGatewayBindMode)) {
    return normalized as OpenClawGatewayBindMode;
  }

  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]' || normalized === '*') {
    return 'lan';
  }

  if (
    normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
  ) {
    return 'loopback';
  }

  return 'loopback';
}

function normalizeGatewayTailscaleMode(value: unknown): 'off' | 'serve' | 'funnel' | string {
  const normalized = normalizeOptionalConfigString(value)?.toLowerCase();
  return normalized ?? 'off';
}

function readGatewayExposureConfig(config: Record<string, unknown>): OpenClawGatewayExposureConfigSnapshot {
  const gateway = config.gateway && typeof config.gateway === 'object' && !Array.isArray(config.gateway)
    ? config.gateway as Record<string, unknown>
    : {};
  const tailscale = gateway.tailscale && typeof gateway.tailscale === 'object' && !Array.isArray(gateway.tailscale)
    ? gateway.tailscale as Record<string, unknown>
    : {};

  return {
    bindMode: normalizeGatewayBindMode(gateway.bind),
    ...(normalizeOptionalConfigString(gateway.customBindHost) ? { customBindHost: normalizeOptionalConfigString(gateway.customBindHost) } : {}),
    tailscaleMode: normalizeGatewayTailscaleMode(tailscale.mode),
  };
}

function assertGatewayBindCompatibleWithTailscale(
  bindMode: OpenClawGatewayBindMode,
  tailscaleMode: string,
): void {
  if ((tailscaleMode === 'serve' || tailscaleMode === 'funnel') && bindMode !== 'loopback') {
    throw new Error(`gateway.bind must remain loopback when gateway.tailscale.mode=${tailscaleMode}`);
  }
}

function ensureA2AInboundToolAccess(config: Record<string, unknown>): void {
  const tools = (
    config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools)
      ? { ...(config.tools as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  tools.profile = 'full';
  config.tools = tools;

  const sandbox = (
    config.sandbox && typeof config.sandbox === 'object' && !Array.isArray(config.sandbox)
      ? { ...(config.sandbox as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const sandboxTools = (
    sandbox.tools && typeof sandbox.tools === 'object' && !Array.isArray(sandbox.tools)
      ? { ...(sandbox.tools as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const alsoAllow = Array.isArray(sandboxTools.alsoAllow)
    ? (sandboxTools.alsoAllow as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];

  if (!alsoAllow.includes('a2a_update_agent_card')) {
    alsoAllow.push('a2a_update_agent_card');
  }

  sandboxTools.alsoAllow = alsoAllow;
  sandbox.tools = sandboxTools;
  config.sandbox = sandbox;
}

function mergeProviderModels(
  ...groups: Array<Array<Record<string, unknown>>>
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const indexes = new Map<string, number>();

  for (const group of groups) {
    for (const item of group) {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (!id) continue;
      const existingIndex = indexes.get(id);
      if (existingIndex === undefined) {
        indexes.set(id, merged.length);
        merged.push(item);
      } else {
        merged[existingIndex] = { ...merged[existingIndex], ...item };
      }
    }
  }
  return merged;
}

function buildRuntimeModelEntry(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    input: modelLooksVisionCapable(id) ? ['text', 'image'] : ['text'],
  };
}

function upsertOpenClawProviderEntry(
  config: Record<string, unknown>,
  provider: string,
  options: ProviderEntryBuildOptions,
): void {
  const models = (config.models || {}) as Record<string, unknown>;
  const providers = (models.providers || {}) as Record<string, unknown>;
  const removedLegacyMoonshot = removeLegacyMoonshotProviderEntry(provider, providers);
  const existingProvider = (
    providers[provider] && typeof providers[provider] === 'object'
      ? (providers[provider] as Record<string, unknown>)
      : {}
  );

  const existingModels = options.mergeExistingModels && Array.isArray(existingProvider.models)
    ? (existingProvider.models as Array<Record<string, unknown>>)
    : [];
  const registryModels = options.includeRegistryModels
    ? ((getProviderConfig(provider)?.models ?? []).map((m) => ({ ...m })) as Array<Record<string, unknown>>)
    : [];
  const runtimeModels = (options.modelIds ?? []).map(buildRuntimeModelEntry);

  const nextProvider: Record<string, unknown> = {
    ...existingProvider,
    baseUrl: options.baseUrl,
    api: options.api,
    models: mergeProviderModels(registryModels, existingModels, runtimeModels),
  };
  if (options.apiKeyEnv) nextProvider.apiKey = options.apiKeyEnv;
  if (options.headers && Object.keys(options.headers).length > 0) {
    nextProvider.headers = options.headers;
  } else {
    delete nextProvider.headers;
  }
  if (options.authHeader !== undefined) {
    nextProvider.authHeader = options.authHeader;
  } else {
    delete nextProvider.authHeader;
  }

  providers[provider] = nextProvider;
  models.providers = providers;
  config.models = models;

  if (removedLegacyMoonshot) {
    logger.info('Removed legacy models.providers.moonshot alias entry');
  }
}

function removeLegacyMoonshotProviderEntry(
  _provider: string,
  _providers: Record<string, unknown>
): boolean {
  return false;
}

function ensureMoonshotKimiWebSearchCnBaseUrl(config: Record<string, unknown>, provider: string): void {
  if (provider !== OPENCLAW_PROVIDER_KEY_MOONSHOT) return;

  const tools = (config.tools || {}) as Record<string, unknown>;
  const web = (tools.web || {}) as Record<string, unknown>;
  const search = (web.search || {}) as Record<string, unknown>;
  const kimi = (search.kimi && typeof search.kimi === 'object' && !Array.isArray(search.kimi))
    ? (search.kimi as Record<string, unknown>)
    : {};

  // Prefer env/auth-profiles for key resolution; stale inline kimi.apiKey can cause persistent 401.
  delete kimi.apiKey;
  kimi.baseUrl = 'https://api.moonshot.cn/v1';
  search.kimi = kimi;
  web.search = search;
  tools.web = web;
  config.tools = tools;
}

/**
 * Register or update a provider's configuration in openclaw.json
 * without changing the current default model.
 */
export async function syncProviderConfigToOpenClaw(
  provider: string,
  modelId: string | undefined,
  override: RuntimeProviderConfigOverride
): Promise<void> {
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    ensureMoonshotKimiWebSearchCnBaseUrl(config, provider);

    if (override.baseUrl && override.api) {
      upsertOpenClawProviderEntry(config, provider, {
        baseUrl: override.baseUrl,
        api: override.api,
        apiKeyEnv: override.apiKeyEnv,
        headers: override.headers,
        modelIds: modelId ? [modelId] : [],
      });
    }

    // Ensure extension is enabled for oauth providers to prevent gateway wiping config
    if (isOpenClawOAuthPluginProviderKey(provider)) {
      const pluginId = getOAuthPluginId(provider);
      ensurePluginEnabled(config, pluginId);
    }

    await writeOpenClawJson(config);
  });
}

/**
 * Update OpenClaw model + provider config using runtime config values.
 */
export async function setOpenClawDefaultModelWithOverride(
  provider: string,
  modelOverride: string | undefined,
  override: RuntimeProviderConfigOverride,
  fallbackModels: string[] = []
): Promise<void> {
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    ensureMoonshotKimiWebSearchCnBaseUrl(config, provider);

    const model = normalizeModelRef(provider, modelOverride);
    if (!model) {
      logger.warn(`No default model mapping for provider "${provider}"`);
      return;
    }

    const modelId = extractModelId(provider, model);
    const fallbackModelIds = extractFallbackModelIds(provider, fallbackModels);

    const agents = (config.agents || {}) as Record<string, unknown>;
    const defaults = (agents.defaults || {}) as Record<string, unknown>;
    defaults.model = {
      primary: model,
      fallbacks: fallbackModels,
    };
    agents.defaults = defaults;
    config.agents = agents;

    if (override.baseUrl && override.api) {
      upsertOpenClawProviderEntry(config, provider, {
        baseUrl: override.baseUrl,
        api: override.api,
        apiKeyEnv: override.apiKeyEnv,
        headers: override.headers,
        authHeader: override.authHeader,
        modelIds: [modelId, ...fallbackModelIds],
      });
    }

    const gateway = (config.gateway || {}) as Record<string, unknown>;
    if (!gateway.mode) gateway.mode = 'local';
    config.gateway = gateway;

    // Ensure the extension plugin is marked as enabled in openclaw.json
    if (isOpenClawOAuthPluginProviderKey(provider)) {
      const pluginId = getOAuthPluginId(provider);
      ensurePluginEnabled(config, pluginId);
    }

    await writeOpenClawJson(config);
    logger.info(
      `Set OpenClaw default model to "${model}" for provider "${provider}" (runtime override)`
    );
  });
}

/**
 * Get a set of all active provider IDs configured in openclaw.json.
 * Reads the file ONCE and extracts both models.providers and plugins.entries.
 */
export async function getActiveOpenClawProviders(): Promise<Set<string>> {
  const activeProviders = new Set<string>();

  try {
    const config = await readOpenClawJson();

    // 1. models.providers
    const providers = (config.models as Record<string, unknown> | undefined)?.providers;
    if (providers && typeof providers === 'object') {
      for (const key of Object.keys(providers as Record<string, unknown>)) {
        activeProviders.add(key);
      }
    }

    // 2. plugins.entries for OAuth providers
    const plugins = (config.plugins as Record<string, unknown> | undefined)?.entries;
    if (plugins && typeof plugins === 'object') {
      for (const [pluginId, meta] of Object.entries(plugins as Record<string, unknown>)) {
        if (pluginId.endsWith('-auth') && (meta as Record<string, unknown>).enabled) {
          activeProviders.add(pluginId.replace(/-auth$/, ''));
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to read openclaw.json for active providers:', err);
  }

  return activeProviders;
}

/**
 * Write the KTClaw gateway token into ~/.openclaw/openclaw.json.
 */
function isValidGatewayPort(port: number | undefined): port is number {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function shouldManageGatewayRemoteUrl(value: unknown, gatewayMode: unknown): boolean {
  if (gatewayMode === 'remote') return false;
  if (typeof value !== 'string' || !value.trim()) return true;

  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  } catch {
    return true;
  }
}

export async function syncGatewayTokenToConfig(token: string, port?: number): Promise<void> {
  return withConfigLock(async () => {
    const config = await readOpenClawJson();

    const gateway = (
      config.gateway && typeof config.gateway === 'object'
        ? { ...(config.gateway as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    const auth = (
      gateway.auth && typeof gateway.auth === 'object'
        ? { ...(gateway.auth as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    auth.mode = 'token';
    auth.token = token;
    gateway.auth = auth;

    const remote = (
      gateway.remote && typeof gateway.remote === 'object'
        ? { ...(gateway.remote as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    remote.token = token;
    if (isValidGatewayPort(port) && shouldManageGatewayRemoteUrl(remote.url, gateway.mode)) {
      remote.url = `ws://127.0.0.1:${port}`;
    }
    gateway.remote = remote;

    // Packaged KTClaw loads the renderer from file://, so the gateway must allow
    // that origin for the chat WebSocket handshake.
    const controlUi = (
      gateway.controlUi && typeof gateway.controlUi === 'object'
        ? { ...(gateway.controlUi as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const allowedOrigins = Array.isArray(controlUi.allowedOrigins)
      ? (controlUi.allowedOrigins as unknown[]).filter((value): value is string => typeof value === 'string')
      : [];
    if (!allowedOrigins.includes('file://')) {
      controlUi.allowedOrigins = [...allowedOrigins, 'file://'];
    }
    gateway.controlUi = controlUi;

    if (!gateway.mode) gateway.mode = 'local';
    config.gateway = gateway;

    await writeOpenClawJson(config);
    logger.info('Synced gateway token to openclaw.json');
  });
}

/**
 * Ensure browser automation is enabled in ~/.openclaw/openclaw.json.
 */
export async function syncBrowserConfigToOpenClaw(): Promise<void> {
  return withConfigLock(async () => {
    const config = await readOpenClawJson();

    const browser = (
      config.browser && typeof config.browser === 'object'
        ? { ...(config.browser as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    let changed = false;

    if (browser.enabled === undefined) {
      browser.enabled = true;
      changed = true;
    }

    if (browser.defaultProfile === undefined) {
      browser.defaultProfile = 'openclaw';
      changed = true;
    }

    if (!changed) return;

    config.browser = browser;
    await writeOpenClawJson(config);
    logger.info('Synced browser config to openclaw.json');
  });
}

export async function getA2APluginConfigFromOpenClaw(): Promise<A2APluginConfigSnapshot> {
  const config = await readOpenClawJson();
  return readA2APluginConfigFromEntry(readPluginEntry(config, 'a2a'));
}

export async function getGatewayExposureConfigFromOpenClaw(): Promise<OpenClawGatewayExposureConfigSnapshot> {
  const config = await readOpenClawJson();
  return readGatewayExposureConfig(config);
}

export async function updateGatewayExposureConfigInOpenClaw(
  patch: OpenClawGatewayExposureConfigPatch,
): Promise<OpenClawGatewayExposureConfigSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    const current = readGatewayExposureConfig(config);
    const nextBindMode = patch.bindMode ?? current.bindMode;

    assertGatewayBindCompatibleWithTailscale(nextBindMode, current.tailscaleMode);

    const gateway = (
      config.gateway && typeof config.gateway === 'object' && !Array.isArray(config.gateway)
        ? { ...(config.gateway as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    gateway.bind = nextBindMode;
    if (!gateway.mode) gateway.mode = 'local';
    config.gateway = gateway;

    await writeOpenClawJson(config);
    logger.info(`Updated OpenClaw gateway bind mode to "${nextBindMode}"`);
    return readGatewayExposureConfig(config);
  });
}

export async function updateA2AInboundConfigInOpenClaw(
  patch: A2AInboundConfigPatch,
): Promise<A2APluginConfigSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    const currentEntry = readPluginEntry(config, 'a2a');
    const entry = patch.enabled === false
      ? setPluginEnabled(config, 'a2a', false)
      : ensurePluginEnabled(config, 'a2a');
    const existingConfig = (
      entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
        ? { ...(entry.config as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const current = readA2APluginConfigFromEntry({
      ...(currentEntry ?? {}),
      config: existingConfig,
      enabled: patch.enabled === undefined ? entry.enabled : patch.enabled,
    });

    existingConfig.inbound = mergeA2AInboundConfig(current.inbound, patch);
    entry.config = existingConfig;

    if (patch.enabled !== false) {
      ensureA2AInboundToolAccess(config);
    }

    await writeOpenClawJson(config);
    logger.info('Updated A2A inbound config in openclaw.json');
    return readA2APluginConfigFromEntry(entry);
  });
}

export async function generateA2AInboundApiKeyInOpenClaw(
  rawLabel: string,
): Promise<{ snapshot: A2APluginConfigSnapshot; apiKey: A2AInboundApiKeyConfig }> {
  const label = normalizeA2AInboundKeyLabel(rawLabel);
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    const entry = ensurePluginEnabled(config, 'a2a');
    const existingConfig = (
      entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
        ? { ...(entry.config as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const current = readA2APluginConfigFromEntry(entry);
    const existingKeys = current.inbound.apiKeys ?? [];

    if (existingKeys.some((key) => key.label.toLowerCase() === label.toLowerCase())) {
      throw new Error(`A2A inbound key label already exists: ${label}`);
    }

    const apiKey = {
      label,
      key: generateA2AInboundAccessKey(),
    };
    const nextInbound: A2APluginInboundConfig = {
      ...current.inbound,
      apiKeys: [...existingKeys, apiKey],
    };

    existingConfig.inbound = nextInbound;
    entry.config = existingConfig;
    ensureA2AInboundToolAccess(config);

    await writeOpenClawJson(config);
    logger.info(`Generated A2A inbound API key "${label}" in openclaw.json`);
    return {
      snapshot: readA2APluginConfigFromEntry(entry),
      apiKey,
    };
  });
}

export async function revokeA2AInboundApiKeyInOpenClaw(
  rawLabel: string,
): Promise<{ snapshot: A2APluginConfigSnapshot; revoked: boolean }> {
  const label = normalizeA2AInboundKeyLabel(rawLabel);
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    const currentEntry = readPluginEntry(config, 'a2a');
    if (!currentEntry) {
      return {
        snapshot: readA2APluginConfigFromEntry(null),
        revoked: false,
      };
    }

    const entry = setPluginEnabled(config, 'a2a', currentEntry.enabled === true);
    const existingConfig = (
      entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
        ? { ...(entry.config as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const current = readA2APluginConfigFromEntry(entry);
    const existingKeys = current.inbound.apiKeys ?? [];
    const nextKeys = existingKeys.filter((key) => key.label !== label);
    const revoked = nextKeys.length !== existingKeys.length;
    const nextInbound: A2APluginInboundConfig = {
      ...current.inbound,
    };

    if (nextKeys.length > 0) {
      nextInbound.apiKeys = nextKeys;
    } else {
      delete nextInbound.apiKeys;
    }

    existingConfig.inbound = nextInbound;
    entry.config = existingConfig;

    if (entry.enabled === true) {
      ensureA2AInboundToolAccess(config);
    }

    await writeOpenClawJson(config);
    logger.info(`Revoked A2A inbound API key "${label}" in openclaw.json: ${revoked}`);
    return {
      snapshot: readA2APluginConfigFromEntry(entry),
      revoked,
    };
  });
}

export async function syncA2APluginConfigToOpenClaw(
  outbound: A2APluginOutboundConfig,
): Promise<void> {
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    const a2aEntry = ensurePluginEnabled(config, 'a2a');
    const existingConfig = (
      a2aEntry.config && typeof a2aEntry.config === 'object'
        ? { ...(a2aEntry.config as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const existingOutbound = (
      existingConfig.outbound && typeof existingConfig.outbound === 'object'
        ? { ...(existingConfig.outbound as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    existingOutbound.agents = outbound.agents;
    existingConfig.outbound = existingOutbound;
    a2aEntry.config = existingConfig;

    await writeOpenClawJson(config);
    logger.info(`Synced A2A plugin config to openclaw.json (${Object.keys(outbound.agents).length} agents)`);
  });
}

/**
 * Update a provider entry in every discovered agent's models.json.
 */
export async function updateAgentModelProvider(
  providerType: string,
  entry: {
    baseUrl?: string;
    api?: string;
    models?: Array<{ id: string; name: string }>;
    apiKey?: string;
    /** When true, pi-ai sends Authorization: Bearer instead of x-api-key */
    authHeader?: boolean;
  }
): Promise<void> {
  const agentIds = await discoverAgentIds();
  for (const agentId of agentIds) {
    const modelsPath = join(getOpenClawConfigDir(), 'agents', agentId, 'agent', 'models.json');
    let data: Record<string, unknown> = {};
    try {
      data = (await readJsonFile<Record<string, unknown>>(modelsPath)) ?? {};
    } catch {
      // corrupt / missing – start with an empty object
    }

    const providers = (
      data.providers && typeof data.providers === 'object' ? data.providers : {}
    ) as Record<string, Record<string, unknown>>;

    const existing: Record<string, unknown> =
      providers[providerType] && typeof providers[providerType] === 'object'
        ? { ...providers[providerType] }
        : {};

    const existingModels = Array.isArray(existing.models)
      ? (existing.models as Array<Record<string, unknown>>)
      : [];

    const mergedModels = (entry.models ?? []).map((m) => {
      const prev = existingModels.find((e) => e.id === m.id);
      return prev ? { ...prev, id: m.id, name: m.name } : { ...m };
    });

    if (entry.baseUrl !== undefined) existing.baseUrl = entry.baseUrl;
    if (entry.api !== undefined) existing.api = entry.api;
    if (mergedModels.length > 0) existing.models = mergedModels;
    if (entry.apiKey !== undefined) existing.apiKey = entry.apiKey;
    if (entry.authHeader !== undefined) existing.authHeader = entry.authHeader;

    providers[providerType] = existing;
    data.providers = providers;

    try {
      await writeJsonFile(modelsPath, data);
      logger.info(`Updated models.json for agent "${agentId}" provider "${providerType}"`);
    } catch (err) {
      logger.warn(`Failed to update models.json for agent "${agentId}":`, err);
    }
  }
}

/**
 * Sanitize ~/.openclaw/openclaw.json before Gateway start.
 *
 * Removes known-invalid keys that cause OpenClaw's strict Zod validation
 * to reject the entire config on startup.  Uses a conservative **blocklist**
 * approach: only strips keys that are KNOWN to be misplaced by older
 * OpenClaw/KTClaw versions or external tools.
 *
 * Why blocklist instead of allowlist?
 *   • Allowlist (e.g. `VALID_SKILLS_KEYS`) would strip any NEW valid keys
 *     added by future OpenClaw releases — a forward-compatibility hazard.
 *   • Blocklist only removes keys we positively know are wrong, so new
 *     valid keys are never touched.
 *
 * This is a fast, file-based pre-check.  For comprehensive repair of
 * unknown or future config issues, the reactive auto-repair mechanism
 * (`runOpenClawDoctorRepair`) runs `openclaw doctor --fix` as a fallback.
 */
export async function sanitizeOpenClawConfig(): Promise<void> {
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    let modified = false;

    // ── skills section ──────────────────────────────────────────────
    // OpenClaw's Zod schema uses .strict() on the skills object, accepting
    // only: allowBundled, load, install, limits, entries.
    // The key "enabled" belongs inside skills.entries[key].enabled, NOT at
    // the skills root level.  Older versions may have placed it there.
    const skills = config.skills;
    if (skills && typeof skills === 'object' && !Array.isArray(skills)) {
      const skillsObj = skills as Record<string, unknown>;
      // Keys that are known to be invalid at the skills root level.
      const KNOWN_INVALID_SKILLS_ROOT_KEYS = ['enabled', 'disabled'];
      for (const key of KNOWN_INVALID_SKILLS_ROOT_KEYS) {
        if (key in skillsObj) {
          logger.info(`[sanitize] Removing misplaced key "skills.${key}" from openclaw.json`);
          delete skillsObj[key];
          modified = true;
        }
      }
    }

    // ── plugins section ──────────────────────────────────────────────
    // Remove absolute paths in plugins that no longer exist or are bundled (preventing hardlink validation errors)
    const plugins = config.plugins;
    if (plugins) {
      if (Array.isArray(plugins)) {
        const validPlugins: unknown[] = [];
        for (const p of plugins) {
          if (typeof p === 'string' && p.startsWith('/')) {
            if (p.includes('node_modules/openclaw/extensions') || !(await fileExists(p))) {
              logger.info(`[sanitize] Removing stale/bundled plugin path "${p}" from openclaw.json`);
              modified = true;
            } else {
              validPlugins.push(p);
            }
          } else {
            validPlugins.push(p);
          }
        }
        if (modified) config.plugins = validPlugins;
      } else if (typeof plugins === 'object') {
        const pluginsObj = plugins as Record<string, unknown>;
        if (Array.isArray(pluginsObj.load)) {
          const validLoad: unknown[] = [];
          for (const p of pluginsObj.load) {
            if (typeof p === 'string' && p.startsWith('/')) {
              if (p.includes('node_modules/openclaw/extensions') || !(await fileExists(p))) {
                logger.info(`[sanitize] Removing stale/bundled plugin path "${p}" from openclaw.json`);
                modified = true;
              } else {
                validLoad.push(p);
              }
            } else {
              validLoad.push(p);
            }
          }
          if (modified) pluginsObj.load = validLoad;
        }
      }
    }

    // ── commands section ───────────────────────────────────────────
    // Required for SIGUSR1 in-process reload authorization.
    const commands = (
      config.commands && typeof config.commands === 'object'
        ? { ...(config.commands as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    if (commands.restart !== true) {
      commands.restart = true;
      config.commands = commands;
      modified = true;
      logger.info('[sanitize] Enabling commands.restart for graceful reload support');
    }

    // ── tools.web.search.kimi ─────────────────────────────────────
    // OpenClaw web_search(kimi) prioritizes tools.web.search.kimi.apiKey over
    // environment/auth-profiles. A stale inline key can cause persistent 401s.
    // When KTClaw-managed moonshot provider exists, prefer centralized key
    // resolution and strip the inline key.
    const providers = ((config.models as Record<string, unknown> | undefined)?.providers as Record<string, unknown> | undefined) || {};
    if (providers[OPENCLAW_PROVIDER_KEY_MOONSHOT]) {
      const tools = (config.tools as Record<string, unknown> | undefined) || {};
      const web = (tools.web as Record<string, unknown> | undefined) || {};
      const search = (web.search as Record<string, unknown> | undefined) || {};
      const kimi = (search.kimi as Record<string, unknown> | undefined) || {};
      if ('apiKey' in kimi) {
        logger.info('[sanitize] Removing stale key "tools.web.search.kimi.apiKey" from openclaw.json');
        delete kimi.apiKey;
        search.kimi = kimi;
        web.search = search;
        tools.web = web;
        config.tools = tools;
        modified = true;
      }
    }

    // ── tools.profile & sessions.visibility ───────────────────────
    // OpenClaw 3.8+ requires tools.profile = 'full' and tools.sessions.visibility = 'all'
    // for KTClaw to properly integrate with its updated tool system.
    const toolsConfig = (config.tools as Record<string, unknown> | undefined) || {};
    let toolsModified = false;

    if (toolsConfig.profile !== 'full') {
      toolsConfig.profile = 'full';
      toolsModified = true;
    }

    const sessions = (toolsConfig.sessions as Record<string, unknown> | undefined) || {};
    if (sessions.visibility !== 'all') {
      sessions.visibility = 'all';
      toolsConfig.sessions = sessions;
      toolsModified = true;
    }

    if (toolsModified) {
      config.tools = toolsConfig;
      modified = true;
      logger.info('[sanitize] Enforced tools.profile="full" and tools.sessions.visibility="all" for OpenClaw 3.8+');
    }

    const channelsObj = config.channels as Record<string, Record<string, unknown>> | undefined;
    if (channelsObj && typeof channelsObj === 'object' && channelsObj.wechat) {
      if (!channelsObj[OPENCLAW_WECHAT_CHANNEL_TYPE]) {
        channelsObj[OPENCLAW_WECHAT_CHANNEL_TYPE] = channelsObj.wechat;
      }
      delete channelsObj.wechat;
      modified = true;
      logger.info(`[sanitize] Migrated channels.wechat -> channels.${OPENCLAW_WECHAT_CHANNEL_TYPE}`);
    }

    // ── plugins.entries.feishu cleanup ──────────────────────────────
    // The official feishu plugin registers its channel AS 'feishu' via
    // openclaw.plugin.json.  An explicit entries.feishu.enabled=false
    // (set by older KTClaw to disable the legacy built-in) blocks the
    // official plugin's channel from starting.  Only clean up when the
    // new openclaw-lark plugin is already configured (to avoid removing
    // a legitimate old-style feishu plugin from users who haven't upgraded).
    if (typeof plugins === 'object' && !Array.isArray(plugins)) {
      const pluginsObj = plugins as Record<string, unknown>;
      const pEntries = pluginsObj.entries as Record<string, Record<string, unknown>> | undefined;

      // ── feishu-openclaw-plugin → openclaw-lark migration ────────
      // Plugin @larksuite/openclaw-lark ≥2026.3.12 changed its manifest
      // id from 'feishu-openclaw-plugin' to 'openclaw-lark'.  Migrate
      // both plugins.allow and plugins.entries so Gateway validation
      // doesn't reject the config with "plugin not found".
      const LEGACY_FEISHU_ID = 'feishu-openclaw-plugin';
      const NEW_FEISHU_ID = 'openclaw-lark';
      if (Array.isArray(pluginsObj.allow)) {
        const allowArr = pluginsObj.allow as string[];
        const legacyIdx = allowArr.indexOf(LEGACY_FEISHU_ID);
        if (legacyIdx !== -1) {
          if (!allowArr.includes(NEW_FEISHU_ID)) {
            allowArr[legacyIdx] = NEW_FEISHU_ID;
          } else {
            allowArr.splice(legacyIdx, 1);
          }
          logger.info(`[sanitize] Migrated plugins.allow: ${LEGACY_FEISHU_ID} → ${NEW_FEISHU_ID}`);
          modified = true;
        }
      }
      if (pEntries?.[LEGACY_FEISHU_ID]) {
        if (!pEntries[NEW_FEISHU_ID]) {
          pEntries[NEW_FEISHU_ID] = pEntries[LEGACY_FEISHU_ID];
        }
        delete pEntries[LEGACY_FEISHU_ID];
        logger.info(`[sanitize] Migrated plugins.entries: ${LEGACY_FEISHU_ID} → ${NEW_FEISHU_ID}`);
        modified = true;
      }

      // ── Remove bare 'feishu' when openclaw-lark is present ─────────
      // The Gateway binary automatically adds bare 'feishu' to plugins.allow
      // because the openclaw-lark plugin registers the 'feishu' channel.
      // However, there's no plugin with id='feishu', so Gateway validation
      // fails with "plugin not found: feishu".  Remove it from allow[] and
      // disable the entries.feishu entry to prevent Gateway from re-adding it.
      const allowArr2 = Array.isArray(pluginsObj.allow) ? pluginsObj.allow as string[] : [];
      const hasNewFeishu = allowArr2.includes(NEW_FEISHU_ID) || !!pEntries?.[NEW_FEISHU_ID];
      if (hasNewFeishu) {
        // Remove bare 'feishu' from plugins.allow
        const bareFeishuIdx = allowArr2.indexOf('feishu');
        if (bareFeishuIdx !== -1) {
          allowArr2.splice(bareFeishuIdx, 1);
          logger.info('[sanitize] Removed bare "feishu" from plugins.allow (openclaw-lark is configured)');
          modified = true;
        }
        // Disable bare 'feishu' in plugins.entries so Gateway won't re-add it
        if (pEntries?.feishu) {
          if (pEntries.feishu.enabled !== false) {
            pEntries.feishu.enabled = false;
            logger.info('[sanitize] Disabled bare plugins.entries.feishu (openclaw-lark is configured)');
            modified = true;
          }
        }
      }

      const LEGACY_WECHAT_ID = 'wechat';
      if (Array.isArray(pluginsObj.allow)) {
        const allowArr = pluginsObj.allow as string[];
        const legacyIdx = allowArr.indexOf(LEGACY_WECHAT_ID);
        if (legacyIdx !== -1) {
          if (!allowArr.includes(OPENCLAW_WECHAT_CHANNEL_TYPE)) {
            allowArr[legacyIdx] = OPENCLAW_WECHAT_CHANNEL_TYPE;
          } else {
            allowArr.splice(legacyIdx, 1);
          }
          logger.info(`[sanitize] Migrated plugins.allow: ${LEGACY_WECHAT_ID} -> ${OPENCLAW_WECHAT_CHANNEL_TYPE}`);
          modified = true;
        }
      }
      if (pEntries?.[LEGACY_WECHAT_ID]) {
        if (!pEntries[OPENCLAW_WECHAT_CHANNEL_TYPE]) {
          pEntries[OPENCLAW_WECHAT_CHANNEL_TYPE] = pEntries[LEGACY_WECHAT_ID];
        }
        delete pEntries[LEGACY_WECHAT_ID];
        logger.info(`[sanitize] Migrated plugins.entries: ${LEGACY_WECHAT_ID} -> ${OPENCLAW_WECHAT_CHANNEL_TYPE}`);
        modified = true;
      }

      const managedChannelPlugins: Array<{ pluginId: string; channelType: string }> = [
        { pluginId: 'openclaw-lark', channelType: 'feishu' },
        { pluginId: 'dingtalk', channelType: 'dingtalk' },
        { pluginId: 'wecom-openclaw-plugin', channelType: 'wecom' },
        { pluginId: 'qqbot', channelType: 'qqbot' },
        { pluginId: OPENCLAW_WECHAT_CHANNEL_TYPE, channelType: OPENCLAW_WECHAT_CHANNEL_TYPE },
      ];

      for (const { pluginId, channelType } of managedChannelPlugins) {
        const hasConfiguredChannel = isActiveConfiguredChannelSection(channelsObj?.[channelType]);
        if (hasConfiguredChannel) {
          continue;
        }
        if (!pEntries?.[pluginId]) {
          continue;
        }
        if (pEntries[pluginId].enabled !== false) {
          pEntries[pluginId].enabled = false;
          logger.info(`[sanitize] Disabled plugins.entries.${pluginId} (channel "${channelType}" is not configured)`);
          modified = true;
        }
      }

      // Non-channel plugins such as A2A are managed separately. If the user has
      // already enabled them in plugins.entries, preserve that intent here.
      if (pEntries?.a2a && pEntries.a2a.enabled === false && Array.isArray(pluginsObj.allow) && pluginsObj.allow.includes('a2a')) {
        pEntries.a2a.enabled = true;
        logger.info('[sanitize] Re-enabled plugins.entries.a2a because plugins.allow includes "a2a"');
        modified = true;
      }
    }

    // ── channels default-account migration ─────────────────────────
    // Most OpenClaw channel plugins read the default account's credentials
    // from the top level of `channels.<type>` (e.g. channels.feishu.appId),
    // but KTClaw historically stored them only under `channels.<type>.accounts.default`.
    // Mirror the default account credentials at the top level so plugins can
    // discover them.
    if (channelsObj && typeof channelsObj === 'object') {
      for (const [channelType, section] of Object.entries(channelsObj)) {
        if (!section || typeof section !== 'object') continue;
        const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;
        const defaultAccount = accounts?.default;
        if (!defaultAccount || typeof defaultAccount !== 'object') continue;
        // Mirror each missing key from accounts.default to the top level
        let mirrored = false;
        for (const [key, value] of Object.entries(defaultAccount)) {
          if (!(key in section)) {
            section[key] = value;
            mirrored = true;
          }
        }
        if (mirrored) {
          modified = true;
          logger.info(`[sanitize] Mirrored ${channelType} default account credentials to top-level channels.${channelType}`);
        }
      }
    }

    if (modified) {
      await writeOpenClawJson(config);
      logger.info('[sanitize] openclaw.json sanitized successfully');
    }
  });
}

export { getProviderEnvVar } from './provider-registry';
