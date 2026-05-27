/**
 * SessionItem Component
 * Displays a compact session item optimized for dense history browsing.
 */

import { useEffect, useRef, useState } from 'react';
import { Crown, MoreVertical, Pin, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { ChatSession } from '@/stores/chat';

interface SessionItemProps {
  session: ChatSession;
  label: string;
  agentName?: string;
  isPinned: boolean;
  isActive: boolean;
  messagePreview?: string;
  onClick: () => void;
  onPinToggle: () => void;
  onDelete: () => void;
}

export function SessionItem({
  session,
  label,
  agentName,
  isPinned,
  isActive,
  onClick,
  onPinToggle,
  onDelete,
}: SessionItemProps) {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const title = formatSessionTitle(session, label);
  const agentLabel = agentName || session.agentId || getAgentIdFromSessionKey(session.key);
  const showUnreadBadge = Boolean(session.unreadCount && session.unreadCount > 0);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  return (
    <div ref={containerRef} className="group relative">
      <button
        type="button"
        aria-label={`Open session ${title}`}
        title={`${title} - Agent ${agentLabel}`}
        className={cn(
          'flex h-10 w-full items-center rounded-lg bg-transparent px-3 pr-10 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/10',
          isActive
            ? 'text-[#3d3a32]'
            : 'text-[#3f3d37]',
        )}
        onClick={onClick}
      >
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium leading-6 tracking-normal">
          {title}
        </span>
        {session.isPrivateChat && session.isLeaderChat && (
          <span className="ml-1.5 inline-flex shrink-0 items-center gap-1 rounded bg-[#f4e8c7] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[#7c5b13]">
            <Crown className="h-3 w-3" />
            {t('teamMap.session.leaderChatBadge', { defaultValue: 'Leader Chat' })}
          </span>
        )}
        {isPinned && (
          <Pin
            className="ml-1.5 h-3.5 w-3.5 shrink-0 text-[#6f6a60]"
            fill="currentColor"
            aria-label="Pinned"
          />
        )}
        {showUnreadBadge && (
          <Badge
            variant="destructive"
            className="ml-1.5 h-4 min-w-[18px] shrink-0 px-1 text-[10px] font-medium"
          >
            {session.unreadCount! > 99 ? '99+' : session.unreadCount}
          </Badge>
        )}
      </button>

      <button
        type="button"
        aria-label="Session actions"
        className={cn(
          'absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-md text-[#6f6a60] transition-opacity hover:bg-[#e5e5ea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/10',
          menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        )}
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((open) => !open);
        }}
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {menuOpen ? (
        <div className="absolute right-1 top-9 z-20 w-28 overflow-hidden rounded-lg bg-white py-1 shadow-[0_8px_24px_rgba(15,23,42,0.14)] ring-1 ring-black/10">
          <button
            type="button"
            aria-label={isPinned ? 'Unpin' : 'Pin'}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-[#3f3d37] hover:bg-[#f4f3ef]"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(false);
              onPinToggle();
            }}
          >
            <Pin className="h-3.5 w-3.5" />
            {isPinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            type="button"
            aria-label="Delete"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-[#b42318] hover:bg-[#fff1f1]"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(false);
              onDelete();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  return sessionKey.split(':')[1] || 'main';
}

function formatSessionTitle(session: ChatSession, label: string): string {
  const trimmedLabel = cleanTitleText(label);
  if (trimmedLabel && trimmedLabel !== session.key) {
    return trimmedLabel;
  }

  if (!session.key.startsWith('agent:')) {
    return trimmedLabel || cleanTitleText(session.displayName || '') || cleanTitleText(session.label || '') || session.key;
  }

  const suffix = session.key.split(':').slice(2).join(':');
  if (!suffix || suffix === 'main') {
    return cleanTitleText(session.displayName || '') || cleanTitleText(session.label || '') || 'Main';
  }
  if (suffix.startsWith('session-')) {
    return `Session ${suffix.slice('session-'.length)}`;
  }
  if (suffix.startsWith('recovered:')) {
    return `Recovered ${suffix.slice('recovered:'.length, 'recovered:'.length + 8)}`;
  }
  return suffix;
}

function cleanTitleText(value: string): string {
  const cleaned = value
    .replace(/\s*\[KTCLAW_DISPATCH_HINTS\][\s\S]*?\[\/KTCLAW_DISPATCH_HINTS\]\s*/g, ' ')
    .replace(/^Conversation info\s*\([^)]*\):\s*```[a-z-]*\r?\n[\s\S]*?```\s*/i, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = cleaned.toLowerCase();
  if (!cleaned || normalized === 'heartbeat' || normalized.startsWith('conversation info')) {
    return '';
  }
  return cleaned;
}
