import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  getCanonicalPrefixFromSessions,
  toMs,
} from './helpers';
import { DEFAULT_CANONICAL_PREFIX, DEFAULT_SESSION_KEY, type ChatSession, type RawMessage } from './types';
import type { ChatGet, ChatSet, SessionHistoryActions } from './store-api';
import { deriveSessionLabelFromMessages } from './session-label-utils';

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

function parseSessionUpdatedAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toMs(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function loadRecoveredSessions(): Promise<ChatSession[]> {
  try {
    const response = await hostApiFetch<{ sessions?: ChatSession[] }>('/api/sessions/discovered');
    return Array.isArray(response.sessions)
      ? response.sessions
        .filter((session) => session && typeof session.key === 'string' && session.key.trim())
        .map((session) => ({
          ...session,
          key: session.key.trim(),
          agentId: session.agentId || getAgentIdFromSessionKey(session.key),
          updatedAt: parseSessionUpdatedAtMs(session.updatedAt),
        }))
      : [];
  } catch {
    return [];
  }
}

function mergeSessionLists(primary: ChatSession[], recovered: ChatSession[]): ChatSession[] {
  const byKey = new Map<string, ChatSession>();
  for (const session of recovered) {
    byKey.set(session.key, session);
  }
  for (const session of primary) {
    const existing = byKey.get(session.key);
    byKey.set(session.key, {
      ...existing,
      ...session,
      agentId: session.agentId || existing?.agentId || getAgentIdFromSessionKey(session.key),
      updatedAt: session.updatedAt ?? existing?.updatedAt,
    });
  }
  return [...byKey.values()].sort((left, right) => (
    (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || left.key.localeCompare(right.key)
  ));
}

async function loadRecoveredHistoryMessages(sessionKey: string, limit = 200): Promise<RawMessage[]> {
  try {
    const response = await hostApiFetch<{ messages?: RawMessage[] }>(
      `/api/sessions/recovered-history?sessionKey=${encodeURIComponent(sessionKey)}&limit=${limit}`,
    );
    return Array.isArray(response.messages) ? response.messages : [];
  } catch {
    return [];
  }
}

async function loadHistoryMessagesForSessionLabel(sessionKey: string): Promise<RawMessage[]> {
  try {
    const r = await invokeIpc(
      'gateway:rpc',
      'chat.history',
      { sessionKey, limit: 1000 },
    ) as { success: boolean; result?: Record<string, unknown> };
    if (r.success && r.result) {
      const messages = Array.isArray(r.result.messages) ? r.result.messages as RawMessage[] : [];
      if (messages.length > 0) return messages;
    }
  } catch {
    // Fall back to transcript recovery below.
  }
  return loadRecoveredHistoryMessages(sessionKey, 1000);
}

export function createSessionActions(
  set: ChatSet,
  get: ChatGet,
): Pick<SessionHistoryActions, 'loadSessions' | 'switchSession' | 'newSession' | 'deleteSession' | 'cleanupEmptySession'> {
  return {
    loadSessions: async () => {
      try {
        const result = await invokeIpc(
          'gateway:rpc',
          'sessions.list',
          {}
        ) as { success: boolean; result?: Record<string, unknown>; error?: string };

        if (result.success && result.result) {
          const data = result.result;
          const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
          const gatewaySessions: ChatSession[] = rawSessions.map((s: Record<string, unknown>) => {
            const key = String(s.key || '');
            return {
              key,
              label: s.label ? String(s.label) : undefined,
              displayName: s.displayName ? String(s.displayName) : undefined,
              thinkingLevel: s.thinkingLevel ? String(s.thinkingLevel) : undefined,
              model: s.model ? String(s.model) : undefined,
              agentId: key ? getAgentIdFromSessionKey(key) : undefined,
              updatedAt: parseSessionUpdatedAtMs(s.updatedAt),
            };
          }).filter((s: ChatSession) => s.key);
          const sessions = mergeSessionLists(gatewaySessions, await loadRecoveredSessions());

          const canonicalBySuffix = new Map<string, string>();
          for (const session of sessions) {
            if (!session.key.startsWith('agent:')) continue;
            const parts = session.key.split(':');
            if (parts.length < 3) continue;
            const suffix = parts.slice(2).join(':');
            if (suffix && !canonicalBySuffix.has(suffix)) {
              canonicalBySuffix.set(suffix, session.key);
            }
          }

          // Deduplicate: if both short and canonical existed, keep canonical only
          const seen = new Set<string>();
          const dedupedSessions = sessions.filter((s) => {
            if (!s.key.startsWith('agent:') && canonicalBySuffix.has(s.key)) return false;
            if (seen.has(s.key)) return false;
            seen.add(s.key);
            return true;
          });

          const { currentSessionKey } = get();
          let nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
          if (!nextSessionKey.startsWith('agent:')) {
            const canonicalMatch = canonicalBySuffix.get(nextSessionKey);
            if (canonicalMatch) {
              nextSessionKey = canonicalMatch;
            }
          }
          if (!dedupedSessions.find((s) => s.key === nextSessionKey) && dedupedSessions.length > 0) {
            // Current session not found in the backend list
            const isNewEmptySession = get().messages.length === 0;
            if (!isNewEmptySession) {
              nextSessionKey = dedupedSessions[0].key;
            }
          }

          const sessionsWithCurrent = !dedupedSessions.find((s) => s.key === nextSessionKey) && nextSessionKey
            ? [
              ...dedupedSessions,
              { key: nextSessionKey, displayName: nextSessionKey },
            ]
            : dedupedSessions;

          const discoveredActivity = Object.fromEntries(
            sessionsWithCurrent
              .filter((session) => typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt))
              .map((session) => [session.key, session.updatedAt!]),
          );

          set((state) => ({
            sessions: sessionsWithCurrent,
            currentSessionKey: nextSessionKey,
            currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
            sessionLastActivity: {
              ...state.sessionLastActivity,
              ...discoveredActivity,
            },
          }));

          if (currentSessionKey !== nextSessionKey) {
            get().loadHistory();
          }

          // Background: fetch first user message for every non-main session to populate labels upfront.
          // Uses a small limit so it's cheap; runs in parallel and doesn't block anything.
          const sessionsToLabel = sessionsWithCurrent.filter((s) => !s.key.endsWith(':main'));
          if (sessionsToLabel.length > 0) {
            void Promise.all(
              sessionsToLabel.map(async (session) => {
                try {
                  const msgs = await loadHistoryMessagesForSessionLabel(session.key);
                  const firstUser = msgs.find((m) => m.role === 'user');
                  const lastMsg = msgs[msgs.length - 1];
                  set((s) => {
                    const next: Partial<typeof s> = {};
                    if (firstUser) {
                      const labelText = deriveSessionLabelFromMessages(msgs);
                      if (labelText) {
                        next.sessionLabels = { ...s.sessionLabels, [session.key]: labelText };
                      }
                    }
                    if (lastMsg?.timestamp) {
                      next.sessionLastActivity = { ...s.sessionLastActivity, [session.key]: toMs(lastMsg.timestamp) };
                    }
                    return next;
                  });
                } catch { /* ignore per-session errors */ }
              }),
            );
          }
        }
      } catch (err) {
        console.warn('Failed to load sessions:', err);
      }
    },

    // ── Switch session ──

    switchSession: (key: string) => {
      const { currentSessionKey, messages } = get();
      const leavingEmpty = !currentSessionKey.endsWith(':main') && messages.length === 0;
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      set((s) => ({
        currentSessionKey: key,
        currentAgentId: getAgentIdFromSessionKey(key),
        messages: [],
        sending: false,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        activeRunId: null,
        error: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        ...(leavingEmpty ? {
          sessions: s.sessions.filter((s) => s.key !== currentSessionKey),
          sessionLabels: Object.fromEntries(
            Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
          ),
          sessionLastActivity: Object.fromEntries(
            Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
          ),
        } : {}),
      }));
      get().loadHistory();
    },

    // ── Delete session ──
    //
    // NOTE: The OpenClaw Gateway does NOT expose a sessions.delete (or equivalent)
    // RPC — confirmed by inspecting client.ts, protocol.ts and the full codebase.
    // Deletion is therefore a local-only UI operation: the session is removed from
    // the sidebar list and its labels/activity maps are cleared.  The underlying
    // JSONL history file on disk is intentionally left intact, consistent with the
    // newSession() design that avoids sessions.reset to preserve history.

    deleteSession: async (key: string) => {
      // Soft-delete the session's JSONL transcript on disk.
      // The main process renames <suffix>.jsonl → <suffix>.deleted.jsonl so that
      // sessions.list skips it automatically.
      try {
        const result = await invokeIpc('session:delete', key) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          console.warn(`[deleteSession] IPC reported failure for ${key}:`, result.error);
        }
      } catch (err) {
        console.warn(`[deleteSession] IPC call failed for ${key}:`, err);
      }

      const { currentSessionKey, sessions } = get();
      const remaining = sessions.filter((s) => s.key !== key);

      if (currentSessionKey === key) {
        // Switched away from deleted session — pick the first remaining or create new
        clearHistoryPoll();
        clearErrorRecoveryTimer();
        const next = remaining[0];
        set((s) => ({
          sessions: remaining,
          sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
          sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
          messages: [],
          sending: false,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          activeRunId: null,
          error: null,
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          currentSessionKey: next?.key ?? DEFAULT_SESSION_KEY,
          currentAgentId: getAgentIdFromSessionKey(next?.key ?? DEFAULT_SESSION_KEY),
        }));
        if (next) {
          get().loadHistory();
        }
      } else {
        set((s) => ({
          sessions: remaining,
          sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
          sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
        }));
      }
    },

    // ── New session ──

    newSession: () => {
      // Generate a new unique session key and switch to it.
      // NOTE: We intentionally do NOT call sessions.reset on the old session.
      // sessions.reset archives (renames) the session JSONL file, making old
      // conversation history inaccessible when the user switches back to it.
      const { currentSessionKey, messages } = get();
      const leavingEmpty = !currentSessionKey.endsWith(':main') && messages.length === 0;
      const prefix = getCanonicalPrefixFromSessions(get().sessions) ?? DEFAULT_CANONICAL_PREFIX;
      const newKey = `${prefix}:session-${Date.now()}`;
      const newSessionEntry: ChatSession = { key: newKey, displayName: newKey };
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      set((s) => ({
        currentSessionKey: newKey,
        currentAgentId: getAgentIdFromSessionKey(newKey),
        sessions: [
          ...(leavingEmpty ? s.sessions.filter((sess) => sess.key !== currentSessionKey) : s.sessions),
          newSessionEntry,
        ],
        sessionLabels: leavingEmpty
          ? Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey))
          : s.sessionLabels,
        sessionLastActivity: leavingEmpty
          ? Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey))
          : s.sessionLastActivity,
        messages: [],
        sending: false,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        activeRunId: null,
        error: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
      }));
    },

    // ── Cleanup empty session on navigate away ──

    cleanupEmptySession: () => {
      const { currentSessionKey, messages } = get();
      // Only remove non-main sessions that were never used (no messages sent).
      // This mirrors the "leavingEmpty" logic in switchSession so that creating
      // a new session and immediately navigating away doesn't leave a ghost entry
      // in the sidebar.
      const isEmptyNonMain = !currentSessionKey.endsWith(':main') && messages.length === 0;
      if (!isEmptyNonMain) return;
      set((s) => ({
        sessions: s.sessions.filter((sess) => sess.key !== currentSessionKey),
        sessionLabels: Object.fromEntries(
          Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
        ),
        sessionLastActivity: Object.fromEntries(
          Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
        ),
      }));
    },

    // ── Load chat history ──

  };
}
