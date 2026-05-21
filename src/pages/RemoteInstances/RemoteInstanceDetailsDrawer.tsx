import { Info, Network, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { RemoteInstance } from '@/stores/remote-instances';

type RemoteInstanceDetailsDrawerProps = {
  instance: RemoteInstance | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function resolveName(instance: RemoteInstance): string {
  return instance.displayName || instance.agentCard?.name || '未命名远程实例';
}

export function RemoteInstanceDetailsDrawer({
  instance,
  open,
  onOpenChange,
}: RemoteInstanceDetailsDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[420px] overflow-y-auto sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{instance ? resolveName(instance) : '远程实例详情'}</SheetTitle>
          <SheetDescription>
            Agent Card 能力、连接诊断和认证摘要。
          </SheetDescription>
        </SheetHeader>

        {instance ? (
          <div className="mt-6 space-y-5">
            <section className="rounded-xl border border-black/[0.06] bg-[#f8fafc] p-4 dark:border-white/10 dark:bg-card">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                <Info className="h-4 w-4 text-[#2563eb]" />
                Agent Card
              </div>
              <p className="text-[12px] leading-6 text-[#64748b] dark:text-muted-foreground">
                {instance.agentCard?.description || '远端还没有提供描述。'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {instance.agentCard?.capabilities.length ? (
                  instance.agentCard.capabilities.map((capability) => (
                    <Badge key={capability.id} variant="secondary">
                      {capability.label}
                    </Badge>
                  ))
                ) : (
                  <span className="text-[12px] text-[#64748b] dark:text-muted-foreground">
                    暂无能力声明
                  </span>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-black/[0.06] bg-[#f8fafc] p-4 dark:border-white/10 dark:bg-card">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                <Network className="h-4 w-4 text-[#16a34a]" />
                连接诊断
              </div>
              {instance.lastTest ? (
                <div className="space-y-2 text-[12px] text-[#64748b] dark:text-muted-foreground">
                  <p className="font-medium text-[#0f172a] dark:text-foreground">
                    {instance.lastTest.status}
                  </p>
                  {instance.lastTest.message ? <p>{instance.lastTest.message}</p> : null}
                  {instance.lastTest.checkedAt ? <p>{instance.lastTest.checkedAt}</p> : null}
                </div>
              ) : (
                <p className="text-[12px] text-[#64748b] dark:text-muted-foreground">
                  暂未运行连接测试。
                </p>
              )}
            </section>

            <section className="rounded-xl border border-black/[0.06] bg-[#f8fafc] p-4 dark:border-white/10 dark:bg-card">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                <Settings className="h-4 w-4 text-[#7c3aed]" />
                配置摘要
              </div>
              <dl className="space-y-2 text-[12px] text-[#64748b] dark:text-muted-foreground">
                <div className="flex justify-between gap-4">
                  <dt>认证方式</dt>
                  <dd className="font-medium text-[#0f172a] dark:text-foreground">{instance.authMode}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>输入模式</dt>
                  <dd className="truncate font-medium text-[#0f172a] dark:text-foreground">
                    {instance.agentCard?.defaultInputModes.join(', ') || '未声明'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>输出模式</dt>
                  <dd className="truncate font-medium text-[#0f172a] dark:text-foreground">
                    {instance.agentCard?.defaultOutputModes.join(', ') || '未声明'}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
