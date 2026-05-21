import { AlertCircle, CheckCircle2, Clock3, RefreshCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RemoteInstance } from '@/stores/remote-instances';

type RemoteInstanceListProps = {
  instances: RemoteInstance[];
  selectedInstanceId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
};

function resolveInstanceName(instance: RemoteInstance): string {
  return instance.displayName || instance.agentCard?.name || '未命名远程实例';
}

function resolveStatus(instance: RemoteInstance): {
  label: string;
  variant: 'success' | 'warning' | 'secondary';
  icon: typeof CheckCircle2;
} {
  if (instance.lastTest?.ok) {
    return { label: '连接正常', variant: 'success', icon: CheckCircle2 };
  }
  if (instance.lastTest) {
    return { label: '需要关注', variant: 'warning', icon: AlertCircle };
  }
  return { label: '未检测', variant: 'secondary', icon: Clock3 };
}

export function RemoteInstanceList({
  instances,
  selectedInstanceId,
  loading,
  onSelect,
  onRefresh,
}: RemoteInstanceListProps) {
  return (
    <aside className="flex min-h-0 w-[320px] shrink-0 flex-col border-r border-black/[0.06] bg-[#f8fafc] dark:border-white/10 dark:bg-card/60">
      <div className="flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-black/[0.06] px-4 dark:border-white/10">
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold text-[#0f172a] dark:text-foreground">
            远程实例
          </h2>
          <p className="mt-0.5 text-[11px] text-[#64748b] dark:text-muted-foreground">
            {instances.length} 个连接端点
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="刷新远程实例"
          onClick={onRefresh}
          disabled={loading}
          className="h-8 w-8"
        >
          <RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {loading && instances.length === 0 ? (
          <div className="rounded-xl border border-dashed border-black/10 bg-white px-4 py-8 text-center text-[13px] text-[#64748b] dark:border-white/10 dark:bg-background dark:text-muted-foreground">
            正在加载远程实例...
          </div>
        ) : null}

        {!loading && instances.length === 0 ? (
          <div className="rounded-xl border border-dashed border-black/10 bg-white px-4 py-8 text-center text-[13px] leading-6 text-[#64748b] dark:border-white/10 dark:bg-background dark:text-muted-foreground">
            还没有远程实例。请先在设置中添加 Agent Card URL。
          </div>
        ) : null}

        {instances.map((instance) => {
          const selected = instance.id === selectedInstanceId;
          const status = resolveStatus(instance);
          const StatusIcon = status.icon;

          return (
            <button
              key={instance.id}
              type="button"
              onClick={() => onSelect(instance.id)}
              className={cn(
                'w-full rounded-xl border px-3.5 py-3 text-left transition-colors',
                selected
                  ? 'border-[#2563eb] bg-[#eff6ff] shadow-sm dark:border-[#3b82f6] dark:bg-[#172554]/30'
                  : 'border-black/[0.06] bg-white hover:border-black/10 hover:bg-[#f2f6fb] dark:border-white/10 dark:bg-background dark:hover:bg-card',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                    {resolveInstanceName(instance)}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-[#64748b] dark:text-muted-foreground">
                    {instance.agentCardUrl}
                  </p>
                </div>
                <Badge variant={status.variant} className="shrink-0 gap-1">
                  <StatusIcon className="h-3 w-3" />
                  {status.label}
                </Badge>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-[#64748b] dark:text-muted-foreground">
                {instance.agentCard?.capabilities.slice(0, 3).map((capability) => (
                  <span
                    key={capability.id}
                    className="rounded-full border border-black/10 bg-white px-2 py-0.5 dark:border-white/10 dark:bg-card"
                  >
                    {capability.label}
                  </span>
                ))}
                {!instance.agentCard?.capabilities.length ? (
                  <span className="rounded-full border border-black/10 bg-white px-2 py-0.5 dark:border-white/10 dark:bg-card">
                    等待 Agent Card
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
