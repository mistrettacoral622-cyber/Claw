import { listProviderAccounts, type ProviderAccount } from '../providers/provider-store';
import { getProviderSecret } from '../secrets/secret-store';

export interface DashScopeCredentials {
  apiKey: string;
  baseUrl: string;
  source: 'provider' | 'env';
  accountId?: string;
}

const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

function looksLikeDashScopeAccount(account: ProviderAccount): boolean {
  const label = account.label.toLowerCase();
  const model = account.model?.toLowerCase() || '';
  const baseUrl = account.baseUrl?.toLowerCase() || '';
  return account.vendorId === 'dashscope'
    || baseUrl.includes('dashscope')
    || model === 'wan2.6-t2i'
    || label.includes('dashscope')
    || account.label.includes('通义万相');
}

function secretToApiKey(secret: Awaited<ReturnType<typeof getProviderSecret>>): string | null {
  if (!secret) {
    return null;
  }
  if (secret.type === 'api_key') {
    return secret.apiKey;
  }
  if (secret.type === 'local') {
    return secret.apiKey ?? null;
  }
  return null;
}

function bearerPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

export async function resolveDashScopeCredentials(options?: { accountId?: string }): Promise<DashScopeCredentials | null> {
  const explicitAccountId = options?.accountId?.trim() || process.env.DASHSCOPE_PROVIDER_ACCOUNT_ID?.trim();
  if (explicitAccountId) {
    const accounts = await listProviderAccounts();
    const account = accounts.find((entry) => entry.id === explicitAccountId);
    const secret = await getProviderSecret(explicitAccountId);
    const apiKey = secretToApiKey(secret);
    if (account && apiKey) {
      return {
        apiKey,
        baseUrl: account.baseUrl?.trim() || process.env.DASHSCOPE_BASE_URL?.trim() || DEFAULT_DASHSCOPE_BASE_URL,
        source: 'provider',
        accountId: account.id,
      };
    }
  }

  const accounts = await listProviderAccounts();
  for (const account of accounts) {
    if (!account.enabled || !looksLikeDashScopeAccount(account)) {
      continue;
    }
    const secret = await getProviderSecret(account.id);
    const apiKey = secretToApiKey(secret);
    if (apiKey) {
      return {
        apiKey,
        baseUrl: account.baseUrl?.trim() || process.env.DASHSCOPE_BASE_URL?.trim() || DEFAULT_DASHSCOPE_BASE_URL,
        source: 'provider',
        accountId: account.id,
      };
    }
  }

  const envApiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!envApiKey) {
    return null;
  }

  return {
    apiKey: envApiKey,
    baseUrl: process.env.DASHSCOPE_BASE_URL?.trim() || DEFAULT_DASHSCOPE_BASE_URL,
    source: 'env',
  };
}

export function redactDashScopeError(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  const replacements = [
    process.env.DASHSCOPE_API_KEY?.trim(),
  ].filter((entry): entry is string => Boolean(entry));

  for (const token of replacements) {
    text = text.replace(bearerPattern(token), '[REDACTED]');
  }

  text = text.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  return text;
}

export { DEFAULT_DASHSCOPE_BASE_URL };
