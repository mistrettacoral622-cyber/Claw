import { useState } from 'react';
import { Loader2, SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

type RemoteInstanceComposerProps = {
  disabled?: boolean;
  sending?: boolean;
  onSend: (message: string) => Promise<void> | void;
};

export function RemoteInstanceComposer({
  disabled = false,
  sending = false,
  onSend,
}: RemoteInstanceComposerProps) {
  const [draft, setDraft] = useState('');
  const trimmedDraft = draft.trim();
  const canSend = trimmedDraft.length > 0 && !disabled && !sending;

  const submit = () => {
    if (!canSend) {
      return;
    }
    const message = trimmedDraft;
    setDraft('');
    void onSend(message);
  };

  return (
    <div className="border-t border-black/[0.06] bg-white px-4 py-3 dark:border-white/10 dark:bg-card">
      <div className="flex items-end gap-2 rounded-2xl border border-black/[0.08] bg-[#f8fafc] px-3 py-2 dark:border-white/10 dark:bg-background">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Message this remote instance"
          aria-label="Message this remote instance"
          disabled={disabled || sending}
          rows={1}
          className="min-h-[36px] max-h-[140px] resize-none border-0 bg-transparent px-0 py-2 text-[14px] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <Button
          type="button"
          size="icon"
          className="mb-0.5 h-8 w-8 shrink-0 rounded-full bg-[#2563eb] text-white hover:bg-[#1d4ed8]"
          disabled={!canSend}
          onClick={submit}
          aria-label="Send remote message"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
        </Button>
      </div>
      <p className="mt-2 px-1 text-[11px] text-[#64748b] dark:text-muted-foreground">
        A2A context is preserved for follow-up turns. File transfer and device control are deferred.
      </p>
    </div>
  );
}
