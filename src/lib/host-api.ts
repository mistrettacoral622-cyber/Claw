import { invokeIpc } from '@/lib/api-client';
import { trackUiEvent } from './telemetry';
import { AppError, normalizeAppError, type AppErrorCode } from './error-model';

const HOST_API_PORT = 3210;
const HOST_API_BASE = `http://127.0.0.1:${HOST_API_PORT}`;
const LOCALHOST_FALLBACK_FLAG = 'ktclaw:allow-localhost-fallback';
const LEGACY_LOCALHOST_FALLBACK_FLAG = 'clawx:allow-localhost-fallback';

/** Cached Host API auth token, fetched once from the main process via IPC. */
let cachedHostApiToken: string | null = null;

async function getHostApiToken(): Promise<string> {
  if (cachedHostApiToken) return cachedHostApiToken;
  try {
    cachedHostApiToken = await invokeIpc<string>('hostapi:token');
  } catch {
    cachedHostApiToken = '';
  }
  return cachedHostApiToken ?? '';
}

type HostApiProxyResponse = {
  ok?: boolean;
  data?: {
    status?: number;
    ok?: boolean;
    json?: unknown;
    text?: string;
  };
  error?: { message?: string } | string;
  // backward compatibility fields
  success: boolean;
  status?: number;
  json?: unknown;
  text?: string;
};

type HostApiProxyData = {
  status?: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
};

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function resolveProxyErrorMessage(error: HostApiProxyResponse['error']): string {
  return typeof error === 'string'
    ? error
    : (error?.message || 'Host API proxy request failed');
}

function readJsonErrorMessage(json: unknown): string | null {
  return typeof json === 'object' && json !== null && 'error' in json
    ? String((json as Record<string, unknown>).error)
    : null;
}

function classifyHttpStatus(status?: number): AppErrorCode {
  if (status === 401) return 'AUTH_INVALID';
  if (status === 403) return 'PERMISSION';
  if (status === 429) return 'RATE_LIMIT';
  if (typeof status === 'number' && status >= 500) return 'GATEWAY';
  return 'UNKNOWN';
}

function createHostApiStatusError(params: {
  status?: number;
  json?: unknown;
  text?: string;
}): AppError {
  const message = params.text || readJsonErrorMessage(params.json) || `HTTP ${params.status ?? 'unknown'}`;
  return new AppError(classifyHttpStatus(params.status), message, undefined, {
    status: params.status ?? null,
    json: params.json,
    text: params.text,
  });
}

function parseUnifiedProxyResponse<T>(
  response: HostApiProxyResponse,
  path: string,
  method: string,
  startedAt: number,
): T {
  if (!response.ok) {
    throw new Error(resolveProxyErrorMessage(response.error));
  }

  const data: HostApiProxyData = response.data ?? {};
  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: 'ipc-proxy',
    durationMs: Date.now() - startedAt,
    status: data.status ?? 200,
  });

  if (data.status === 204) return undefined as T;
  if (data.ok === false) {
    throw createHostApiStatusError({
      status: data.status,
      json: data.json,
      text: data.text,
    });
  }
  if (data.json !== undefined) return data.json as T;
  return data.text as T;
}

function parseLegacyProxyResponse<T>(
  response: HostApiProxyResponse,
  path: string,
  method: string,
  startedAt: number,
): T {
  if (!response.success) {
    throw new Error(resolveProxyErrorMessage(response.error));
  }

  if (!response.ok) {
    throw createHostApiStatusError({
      status: response.status,
      json: response.json,
      text: response.text,
    });
  }

  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: 'ipc-proxy-legacy',
    durationMs: Date.now() - startedAt,
    status: response.status ?? 200,
  });

  if (response.status === 204) return undefined as T;
  if (response.json !== undefined) return response.json as T;
  return response.text as T;
}

function shouldFallbackToBrowser(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('invalid ipc channel: hostapi:fetch')
    || normalized.includes("no handler registered for 'hostapi:fetch'")
    || normalized.includes('no handler registered for "hostapi:fetch"')
    || normalized.includes('no handler registered for hostapi:fetch')
    || normalized.includes('window is not defined');
}

function allowLocalhostFallback(): boolean {
  try {
    const flag = window.localStorage.getItem(LOCALHOST_FALLBACK_FLAG);
    if (flag === '1') {
      return true;
    }
    const legacyFlag = window.localStorage.getItem(LEGACY_LOCALHOST_FALLBACK_FLAG);
    if (legacyFlag === '1') {
      window.localStorage.setItem(LOCALHOST_FALLBACK_FLAG, '1');
      window.localStorage.removeItem(LEGACY_LOCALHOST_FALLBACK_FLAG);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isBrowserPreviewShimEnabled(): boolean {
  try {
    return Boolean(
      (window.electron as { __ktclawBrowserPreviewShim?: boolean } | undefined)
        ?.__ktclawBrowserPreviewShim,
    );
  } catch {
    return false;
  }
}

type BrowserFetchMode = {
  source: 'browser-preview-shim' | 'browser-fallback';
  includeAuthToken: boolean;
};

function shouldAttachJsonContentType(method: string, body: BodyInit | null | undefined): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  return typeof body === 'string';
}

async function runBrowserFetch<T>(
  path: string,
  init: RequestInit | undefined,
  method: string,
  startedAt: number,
  mode: BrowserFetchMode,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (shouldAttachJsonContentType(method, init?.body) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (mode.includeAuthToken) {
    const token = await getHostApiToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const response = await fetch(`${HOST_API_BASE}${path}`, {
    ...init,
    method,
    headers,
  });
  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: mode.source,
    durationMs: Date.now() - startedAt,
    status: response.status,
  });

  if (response.status === 204) return undefined as T;

  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = await response.json();
      if (!response.ok) {
        throw createHostApiStatusError({
          status: response.status,
          json,
        });
      }
      return json as T;
    }
    const text = await response.text();
    if (!response.ok) {
      throw createHostApiStatusError({
        status: response.status,
        text,
      });
    }
    return text as T;
  } catch (error) {
    throw normalizeAppError(error, { source: mode.source, path, method });
  }
}

export async function hostApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const startedAt = Date.now();
  const method = init?.method || 'GET';
  if (isBrowserPreviewShimEnabled()) {
    return runBrowserFetch<T>(path, init, method, startedAt, {
      source: 'browser-preview-shim',
      includeAuthToken: false,
    });
  }
  // In Electron renderer, always proxy through main process to avoid CORS.
  try {
    const response = await invokeIpc<HostApiProxyResponse>('hostapi:fetch', {
      path,
      method,
      headers: headersToRecord(init?.headers),
      body: init?.body ?? null,
    });

    if (typeof response?.ok === 'boolean' && 'data' in response) {
      return parseUnifiedProxyResponse<T>(response, path, method, startedAt);
    }

    return parseLegacyProxyResponse<T>(response, path, method, startedAt);
  } catch (error) {
    const normalized = normalizeAppError(error, { source: 'ipc-proxy', path, method });
    const message = normalized.message;
    trackUiEvent('hostapi.fetch_error', {
      path,
      method,
      source: 'ipc-proxy',
      durationMs: Date.now() - startedAt,
      message,
      code: normalized.code,
    });
    if (!shouldFallbackToBrowser(message)) {
      throw normalized;
    }
    if (!allowLocalhostFallback()) {
      trackUiEvent('hostapi.fetch_error', {
        path,
        method,
        source: 'ipc-proxy',
        durationMs: Date.now() - startedAt,
        message: 'localhost fallback blocked by policy',
        code: 'CHANNEL_UNAVAILABLE',
      });
      throw normalized;
    }
  }

  // Browser-only fallback (non-Electron environments).
  return runBrowserFetch<T>(path, init, method, startedAt, {
    source: 'browser-fallback',
    includeAuthToken: true,
  });
}

export function createHostEventSource(path = '/api/events'): EventSource {
  // EventSource does not support custom headers, so pass the auth token
  // as a query parameter. The server accepts both mechanisms.
  const separator = path.includes('?') ? '&' : '?';
  const tokenParam = `token=${encodeURIComponent(cachedHostApiToken ?? '')}`;
  return new EventSource(`${HOST_API_BASE}${path}${separator}${tokenParam}`);
}

export function getHostApiBase(): string {
  return HOST_API_BASE;
}
