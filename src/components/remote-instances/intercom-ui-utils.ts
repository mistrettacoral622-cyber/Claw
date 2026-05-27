import type { IntercomRoute } from '@/stores/intercom';
import type { RawMessage } from '@/stores/chat';

export type IntercomRouteDraft = {
  id: string;
  displayName: string;
  host: string;
  sshUser: string;
  sshPort: string;
  sshPassword: string;
  clearSshPassword: boolean;
  sshPasswordConfigured: boolean;
  agent: string;
  sessionId: string;
  remoteCommand: string;
};

export const DEFAULT_INTERCOM_SESSION_ID = 'intercom';
export const DEFAULT_INTERCOM_ROUTE_ID = 'remote-ktclaw';
export const DEFAULT_REMOTE_KTCLAW_COMMAND = 'openclaw';
export const DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND = DEFAULT_REMOTE_KTCLAW_COMMAND;
export const INTERCOM_CONNECTION_SHARE_TYPE = 'ktclaw-intercom-route';

type IntercomConnectionShare = {
  type?: string;
  version?: number;
  id?: string;
  routeId?: string;
  displayName?: string;
  host?: string;
  sshUser?: string;
  sshPort?: number | string;
  agent?: string;
  agentId?: string;
  sessionId?: string;
  remoteCommand?: string;
};

export function emptyIntercomRouteDraft(): IntercomRouteDraft {
  return {
    id: '',
    displayName: '',
    host: '',
    sshUser: '',
    sshPort: '22',
    sshPassword: '',
    clearSshPassword: false,
    sshPasswordConfigured: false,
    agent: 'main',
    sessionId: DEFAULT_INTERCOM_SESSION_ID,
    remoteCommand: DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND,
  };
}

export function deriveIntercomRouteDraft(route: IntercomRoute | null): IntercomRouteDraft {
  if (!route) {
    return emptyIntercomRouteDraft();
  }

  return {
    id: route.id,
    displayName: route.displayName || route.id,
    host: route.host,
    sshUser: route.sshUser ?? '',
    sshPort: route.sshPort ? String(route.sshPort) : '22',
    sshPassword: '',
    clearSshPassword: false,
    sshPasswordConfigured: route.sshPasswordConfigured,
    agent: route.agent,
    sessionId: route.sessionId || DEFAULT_INTERCOM_SESSION_ID,
    remoteCommand: route.remoteCommand || DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND,
  };
}

export function normalizeIntercomPort(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error('SSH port must be a number between 1 and 65535');
  }

  return parsed;
}

export function buildSshPreview(route: IntercomRouteDraft, message: string, sender: string): string {
  const host = route.sshUser.trim()
    ? `${route.sshUser.trim()}@${route.host.trim() || '<remote-host>'}`
    : route.host.trim() || '<remote-host>';
  const command = route.remoteCommand.trim() || DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND;
  const agent = route.agent.trim() || '<agent>';
  const session = route.sessionId.trim() || DEFAULT_INTERCOM_SESSION_ID;
  const text = message.trim() || '<message>';
  const from = sender.trim() || '<sender>';

  return `ssh ${host} "${command} agent --agent ${agent} --session-id ${session} --message '[from agent ${from}] ${text}' --json"`;
}

function readShareString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readSharePort(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return readShareString(value);
}

export function parseIntercomConnectionShare(text: string): Partial<IntercomRouteDraft> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  let payload: IntercomConnectionShare | null = null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as IntercomConnectionShare;
    }
  } catch {
    return null;
  }

  if (!payload || (payload.type && payload.type !== INTERCOM_CONNECTION_SHARE_TYPE)) {
    return null;
  }

  const host = readShareString(payload.host);
  const agent = readShareString(payload.agent) || readShareString(payload.agentId);
  if (!host || !agent) {
    return null;
  }

  return {
    id: readShareString(payload.routeId) || readShareString(payload.id),
    displayName: readShareString(payload.displayName),
    host,
    sshUser: readShareString(payload.sshUser),
    sshPort: readSharePort(payload.sshPort) || '22',
    agent,
    sessionId: readShareString(payload.sessionId) || DEFAULT_INTERCOM_SESSION_ID,
    remoteCommand: readShareString(payload.remoteCommand) || DEFAULT_REMOTE_KTCLAW_COMMAND,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeIntercomOutput(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replaceAll(String.fromCharCode(0), '')
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
    .trim();
}

function findJsonCandidate(value: string): string | null {
  const start = value.search(/[{}[\]]/);
  if (start < 0) {
    return null;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (char === '}' || char === ']') {
      const expected = stack.pop();
      if (expected !== char) {
        return null;
      }
      if (stack.length === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseIntercomJson(value: string): unknown | null {
  const trimmed = normalizeIntercomOutput(value);
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const candidate = findJsonCandidate(trimmed);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function decodeJsonStringLiteral(value: string): string | null {
  try {
    const parsed = JSON.parse(`"${value}"`);
    return typeof parsed === 'string' ? parsed.trim() : null;
  } catch {
    return null;
  }
}

function extractJsonTextFields(value: string): string[] {
  const texts: string[] = [];
  const regex = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match = regex.exec(value);
  while (match) {
    const text = decodeJsonStringLiteral(match[1]);
    if (text) {
      texts.push(text);
    }
    match = regex.exec(value);
  }
  return texts;
}

function readContentText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry.trim();
        }
        if (isRecord(entry) && typeof entry.text === 'string') {
          return entry.text.trim();
        }
        if (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string') {
          return entry.text.trim();
        }
        if (isRecord(entry) && typeof entry.content === 'string') {
          return entry.content.trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') {
      return value.text.trim();
    }
    const content = readContentText(value.content);
    if (content) {
      return content;
    }
  }
  return '';
}

function collectDisplayTexts(value: unknown, texts: string[], seen = new Set<unknown>(), depth = 0): void {
  if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDisplayTexts(entry, texts, seen, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (typeof value.text === 'string' && value.text.trim()) {
    texts.push(value.text.trim());
  }

  for (const key of ['content', 'response', 'reply', 'answer', 'output', 'message', 'result', 'data']) {
    collectDisplayTexts(value[key], texts, seen, depth + 1);
  }
}

function findDisplayText(value: unknown): string {
  const preferred = findPreferredOutputText(value).trim();
  if (preferred) {
    return preferred;
  }

  const texts: string[] = [];
  collectDisplayTexts(value, texts);
  return texts.join('\n\n').trim();
}

function collectAssistantTexts(value: unknown, texts: string[], seen = new Set<unknown>(), depth = 0): void {
  if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAssistantTexts(entry, texts, seen, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const role = typeof value.role === 'string' ? value.role.toLowerCase() : '';
  if (role === 'assistant') {
    const text = readContentText(value.content ?? value.message ?? value.text);
    if (text) {
      texts.push(text);
    }
  }

  for (const entry of Object.values(value)) {
    collectAssistantTexts(entry, texts, seen, depth + 1);
  }
}

function normalizeRawMessage(value: unknown): RawMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const role = value.role === 'user' || value.role === 'assistant' || value.role === 'system' || value.role === 'toolresult'
    ? value.role
    : null;
  if (!role) {
    return null;
  }
  const content = normalizeRawMessageContent(value.content ?? value.message ?? value.text);
  if (content == null) {
    return null;
  }
  return {
    ...value,
    role,
    content,
    id: typeof value.id === 'string' ? value.id : undefined,
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : undefined,
  } as RawMessage;
}

function normalizeRawMessageContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((entry) => {
      if (typeof entry === 'string') {
        return { type: 'text', text: entry };
      }
      if (!isRecord(entry)) {
        return entry;
      }
      if (typeof entry.text === 'string' && (entry.type == null || entry.type === 'output_text')) {
        return {
          ...entry,
          type: 'text',
        };
      }
      return entry;
    });
  }
  const text = readContentText(content);
  return text || content;
}

function collectRawMessages(value: unknown, messages: RawMessage[], seen = new Set<unknown>(), depth = 0): void {
  if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRawMessages(entry, messages, seen, depth + 1);
    }
    return;
  }

  const message = normalizeRawMessage(value);
  if (message) {
    messages.push(message);
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const key of ['messages', 'history', 'items', 'result', 'data']) {
    collectRawMessages(value[key], messages, seen, depth + 1);
  }
}

function findPreferredOutputText(value: unknown, depth = 0): string {
  if (depth > 4) {
    return '';
  }
  const text = readContentText(value);
  if (text) {
    return text;
  }
  if (!isRecord(value)) {
    return '';
  }

  for (const key of ['response', 'reply', 'answer', 'output', 'text']) {
    const direct = readContentText(value[key]);
    if (direct) {
      return direct;
    }
  }

  for (const key of ['result', 'data', 'message']) {
    const nested = findPreferredOutputText(value[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  return '';
}

function stripNoisyIntercomLines(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[plugins]\s+/i.test(line))
    .join('\n')
    .trim();
}

function looksLikeStructuredOutput(value: string): boolean {
  const trimmed = normalizeIntercomOutput(value);
  return /^[{[]/.test(trimmed) || /"(?:content|messages|meta|text)"\s*:/.test(trimmed);
}

export function extractIntercomReplyText(stdout: string): string {
  const trimmed = normalizeIntercomOutput(stdout);
  if (!trimmed) {
    return '';
  }

  const parsed = parseIntercomJson(trimmed);
  if (parsed !== null) {
    const assistantTexts: string[] = [];
    collectAssistantTexts(parsed, assistantTexts);
    const assistantText = assistantTexts.at(-1)?.trim();
    if (assistantText) {
      return assistantText;
    }

    const preferred = findDisplayText(parsed);
    if (preferred) {
      return preferred;
    }

    return '';
  }

  const recoveredTexts = extractJsonTextFields(trimmed);
  if (recoveredTexts.length > 0) {
    return recoveredTexts.join('\n\n').trim();
  }

  const cleaned = stripNoisyIntercomLines(trimmed);
  if (looksLikeStructuredOutput(cleaned)) {
    return '';
  }
  if (cleaned.length <= 4000) {
    return cleaned;
  }
  return `${cleaned.slice(0, 4000).trim()}\n...`;
}

export function extractIntercomReplyMessages(stdout: string): RawMessage[] {
  const trimmed = normalizeIntercomOutput(stdout);
  if (!trimmed) {
    return [];
  }

  const parsed = parseIntercomJson(trimmed);
  if (parsed !== null) {
    const rawMessages: RawMessage[] = [];
    collectRawMessages(parsed, rawMessages);
    if (rawMessages.length > 0) {
      return rawMessages;
    }

    const text = findDisplayText(parsed);
    if (text) {
      return [{ role: 'assistant', content: text }];
    }
  }

  const recoveredTexts = extractJsonTextFields(trimmed);
  if (recoveredTexts.length > 0) {
    return [{ role: 'assistant', content: recoveredTexts.join('\n\n').trim() }];
  }

  const text = extractIntercomReplyText(trimmed);
  return text ? [{ role: 'assistant', content: text }] : [];
}
