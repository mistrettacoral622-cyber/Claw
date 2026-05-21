import { Bot, Clock3, MessageSquare, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import MarkdownContent from '@/pages/Chat/MarkdownContent';
import type {
  RemoteAgentCardCapability,
  RemoteConversationMessage,
  RemoteInstance,
  RemoteInstanceConversationThread,
} from '@/stores/remote-instances';

type RemoteInstanceConversationProps = {
  instance: RemoteInstance;
  thread: RemoteInstanceConversationThread;
  sending: boolean;
};

function resolveInstanceName(instance: RemoteInstance): string {
  return instance.displayName || instance.agentCard?.name || 'Remote instance';
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function CapabilityBadge({ capability }: { capability: RemoteAgentCardCapability }) {
  return (
    <Badge variant="secondary" title={capability.description ?? undefined}>
      {capability.label}
    </Badge>
  );
}

function RemoteMessageBubble({ message }: { message: RemoteConversationMessage }) {
  const isUser = message.role === 'user';
  const Icon = isUser ? User : Bot;

  return (
    <div className={cn('flex gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={cn(
          'mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
          isUser
            ? 'bg-[#2563eb] text-white'
            : 'bg-[#ecfdf5] text-[#047857] dark:bg-emerald-950/40 dark:text-emerald-200',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>

      <div className={cn('flex min-w-0 flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'max-w-[760px] rounded-2xl px-3.5 py-2.5 text-[14px] leading-6 shadow-sm',
            isUser
              ? 'rounded-tr-md bg-[#2563eb] text-white'
              : 'rounded-tl-md border border-black/[0.06] bg-white text-[#0f172a] dark:border-white/10 dark:bg-background dark:text-foreground',
            message.status === 'error' && 'border border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-100',
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <MarkdownContent content={message.content} />
          )}
        </div>
        <div className="flex items-center gap-2 px-1 text-[11px] text-[#64748b] dark:text-muted-foreground">
          <span>{formatTime(message.createdAt)}</span>
          {message.status === 'sending' ? <span>Sending</span> : null}
          {message.status === 'error' && message.error ? <span>{message.error}</span> : null}
          {message.taskId ? <span className="font-mono">task_id: {message.taskId}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function RemoteInstanceConversation({
  instance,
  thread,
  sending,
}: RemoteInstanceConversationProps) {
  const capabilities = instance.agentCard?.capabilities ?? [];
  const hasMessages = thread.messages.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-black/[0.06] px-5 py-4 dark:border-white/10">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#64748b] dark:text-muted-foreground">
              Remote conversation
            </p>
            <h2 className="mt-1 truncate text-[20px] font-semibold text-[#0f172a] dark:text-foreground">
              {resolveInstanceName(instance)}
            </h2>
            <p className="mt-1 max-w-[640px] text-[13px] leading-6 text-[#64748b] dark:text-muted-foreground">
              {instance.agentCard?.description || 'One primary A2A conversation is kept for this remote instance.'}
            </p>
          </div>

          <div className="hidden shrink-0 text-right text-[11px] text-[#64748b] dark:text-muted-foreground md:block">
            <div className="font-semibold text-[#0f172a] dark:text-foreground">Continuity</div>
            <div className="mt-1 font-mono">context_id: {thread.contextId ?? 'new'}</div>
            <div className="mt-0.5 font-mono">task_id: {thread.taskId ?? 'new'}</div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {capabilities.slice(0, 6).map((capability) => (
            <CapabilityBadge key={capability.id} capability={capability} />
          ))}
          {capabilities.length === 0 ? <Badge variant="outline">Agent Card pending</Badge> : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5" data-testid="remote-transcript">
        {!hasMessages ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f0fdf4] text-[#16a34a] dark:bg-emerald-950/30 dark:text-emerald-200">
              <MessageSquare className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-[16px] font-semibold text-[#0f172a] dark:text-foreground">
              Start the remote thread
            </h3>
            <p className="mt-2 max-w-[520px] text-[13px] leading-6 text-[#64748b] dark:text-muted-foreground">
              Messages sent here stay in the remote-instance workbench and reuse the same A2A context on follow-up turns.
            </p>
          </div>
        ) : (
          thread.messages.map((message) => (
            <RemoteMessageBubble key={message.id} message={message} />
          ))
        )}

        {sending ? (
          <div className="flex items-center gap-2 text-[12px] text-[#64748b] dark:text-muted-foreground" aria-live="polite">
            <Clock3 className="h-3.5 w-3.5 animate-pulse" />
            Waiting for remote reply
          </div>
        ) : null}
      </div>
    </div>
  );
}
