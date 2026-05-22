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
export const DEFAULT_INTERCOM_ROUTE_ID = 'linux-ktclaw';
export const DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND =
  'ELECTRON_RUN_AS_NODE=1 /opt/KTClaw/ktclaw /opt/KTClaw/resources/openclaw/openclaw.mjs';

export function emptyIntercomRouteDraft(): IntercomRouteDraft {
  return {
    id: DEFAULT_INTERCOM_ROUTE_ID,
    displayName: 'Linux KTClaw',
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
    ? `${route.sshUser.trim()}@${route.host.trim() || '<linux-host>'}`
    : route.host.trim() || '<linux-host>';
  const command = route.remoteCommand.trim() || DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND;
  const agent = route.agent.trim() || '<agent>';
  const session = route.sessionId.trim() || DEFAULT_INTERCOM_SESSION_ID;
  const text = message.trim() || '<message>';
  const from = sender.trim() || '<sender>';

  return `ssh ${host} "${command} agent --agent ${agent} --session-id ${session} --message '[from agent ${from}] ${text}' --json"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIntercomJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
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

export function extractIntercomReplyText(stdout: string): string {
  const trimmed = stdout.trim();
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

    const preferred = findPreferredOutputText(parsed).trim();
    if (preferred) {
      return preferred;
    }

    return trimmed.length <= 2000 ? trimmed : '';
  }

  const cleaned = stripNoisyIntercomLines(trimmed);
  if (cleaned.length <= 4000) {
    return cleaned;
  }
  return `${cleaned.slice(0, 4000).trim()}\n...`;
}

export function extractIntercomReplyMessages(stdout: string): RawMessage[] {
  const trimmed = stdout.trim();
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

    const text = findPreferredOutputText(parsed).trim();
    if (text) {
      return [{ role: 'assistant', content: text }];
    }
    return [];
  }

  const text = extractIntercomReplyText(trimmed);
  return text ? [{ role: 'assistant', content: text }] : [];
}
