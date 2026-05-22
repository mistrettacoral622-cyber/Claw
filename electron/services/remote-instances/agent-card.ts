import { proxyAwareFetch } from '../../utils/proxy-fetch';
import type {
  RemoteAgentCardSkillSnapshot,
  RemoteAgentCardSnapshot,
  RemoteInstanceHeaderAuth,
} from './config';

type JsonObject = Record<string, unknown>;

export interface AgentCardFetchOptions {
  url: string;
  auth?: RemoteInstanceHeaderAuth;
  timeoutMs?: number;
}

export interface AgentCardFetchResult {
  agentCard: RemoteAgentCardSnapshot;
  latencyMs: number;
  httpStatus: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildRequestHeaders(auth?: RemoteInstanceHeaderAuth): Headers {
  const headers = new Headers({
    Accept: 'application/json',
  });

  if (!auth) {
    return headers;
  }

  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (key.trim() && value.trim()) {
      headers.set(key, value);
    }
  }

  if ((auth.mode === 'bearer' || auth.mode === 'mixed') && auth.token?.trim()) {
    headers.set('Authorization', `Bearer ${auth.token.trim()}`);
  }

  return headers;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause instanceof Error
      ? ` (${error.cause.message})`
      : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

function formatAgentCardFetchError(url: string, error: unknown, timeoutMs: number): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`Timed out after ${timeoutMs}ms while fetching Agent Card from ${url}`);
  }

  const detail = readErrorMessage(error);
  return new Error(
    `Unable to fetch Agent Card from ${url}: ${detail}. Verify the remote Gateway is running, network access is set to LAN or a reachable tunnel, and the firewall allows the Gateway port.`,
  );
}

function normalizeSkill(value: unknown): RemoteAgentCardSkillSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeString(value.id);
  const name = normalizeString(value.name);
  const description = normalizeString(value.description);

  if (!id || !name || !description) {
    return null;
  }

  return {
    id,
    name,
    description,
    tags: normalizeStringArray(value.tags),
    examples: normalizeStringArray(value.examples),
    inputModes: normalizeStringArray(value.inputModes),
    outputModes: normalizeStringArray(value.outputModes),
  };
}

function normalizeCapabilities(payload: JsonObject): string[] {
  const capabilitySections = payload.capabilities;
  if (Array.isArray(capabilitySections)) {
    return normalizeStringArray(capabilitySections);
  }
  if (isRecord(capabilitySections)) {
    return Object.entries(capabilitySections)
      .filter(([, value]) => value === true || isRecord(value))
      .map(([key]) => key);
  }
  return [];
}

function pickProvider(payload: JsonObject): JsonObject | null {
  if (isRecord(payload.provider)) {
    return payload.provider;
  }
  return null;
}

function pickDocumentationUrl(payload: JsonObject): string | undefined {
  return normalizeString(payload.documentationUrl || payload.url || payload.docsUrl) || undefined;
}

export function normalizeAgentCardPayload(payload: unknown, sourceUrl: string): RemoteAgentCardSnapshot {
  if (!isRecord(payload)) {
    throw new Error('Agent Card response must be a JSON object');
  }

  const name = normalizeString(payload.name);
  if (!name) {
    throw new Error('Agent Card is missing required field: name');
  }

  const rawSkills = Array.isArray(payload.skills) ? payload.skills : [];
  const skills = rawSkills
    .map(normalizeSkill)
    .filter((skill): skill is RemoteAgentCardSkillSnapshot => skill !== null);

  return {
    name,
    description: normalizeString(payload.description),
    url: normalizeString(payload.url) || sourceUrl,
    protocolVersion: normalizeString(payload.protocolVersion || payload.protocol_version) || undefined,
    provider: pickProvider(payload),
    version: normalizeString(payload.version) || undefined,
    documentationUrl: pickDocumentationUrl(payload),
    capabilities: normalizeCapabilities(payload),
    defaultInputModes: normalizeStringArray(payload.defaultInputModes || payload.default_input_modes),
    defaultOutputModes: normalizeStringArray(payload.defaultOutputModes || payload.default_output_modes),
    skills,
    raw: payload,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchAgentCard(options: AgentCardFetchOptions): Promise<AgentCardFetchResult> {
  const controller = new AbortController();
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    let response: Response;
    try {
      response = await proxyAwareFetch(options.url, {
        method: 'GET',
        headers: buildRequestHeaders(options.auth),
        signal: controller.signal,
      });
    } catch (error) {
      throw formatAgentCardFetchError(options.url, error, timeoutMs);
    }

    const latencyMs = Date.now() - startedAt;
    const httpStatus = response.status;

    if (!response.ok) {
      throw new Error(`Agent Card request failed with HTTP ${httpStatus}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new Error(`Agent Card request returned unexpected content type: ${contentType || 'unknown'}`);
    }

    const payload = await response.json();
    return {
      agentCard: normalizeAgentCardPayload(payload, options.url),
      latencyMs,
      httpStatus,
    };
  } finally {
    clearTimeout(timer);
  }
}
