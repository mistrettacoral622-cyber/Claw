import type { IntercomRoute } from '@/stores/intercom';

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
    remoteCommand: 'openclaw',
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
    remoteCommand: route.remoteCommand || 'openclaw',
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
  const command = route.remoteCommand.trim() || 'openclaw';
  const agent = route.agent.trim() || '<agent>';
  const session = route.sessionId.trim() || DEFAULT_INTERCOM_SESSION_ID;
  const text = message.trim() || '<message>';
  const from = sender.trim() || '<sender>';

  return `ssh ${host} "${command} agent --agent ${agent} --session-id ${session} --message '[from agent ${from}] ${text}' --json"`;
}
