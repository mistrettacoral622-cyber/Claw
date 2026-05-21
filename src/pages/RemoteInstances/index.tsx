import { useEffect, useMemo, useState } from 'react';
import { Info, Loader2, Network, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useRemoteInstancesStore } from '@/stores/remote-instances';
import { RemoteInstanceComposer } from './RemoteInstanceComposer';
import { RemoteInstanceConversation } from './RemoteInstanceConversation';
import { RemoteInstanceDetailsDrawer } from './RemoteInstanceDetailsDrawer';
import { RemoteInstanceList } from './RemoteInstanceList';

function formatSelectedTitle(name: string | null | undefined, fallback: string): string {
  return name?.trim() || fallback;
}

export function RemoteInstances() {
  const navigate = useNavigate();
  const instances = useRemoteInstancesStore((state) => state.instances);
  const selectedInstanceId = useRemoteInstancesStore((state) => state.selectedInstanceId);
  const threadsByInstanceId = useRemoteInstancesStore((state) => state.threadsByInstanceId);
  const loading = useRemoteInstancesStore((state) => state.loading);
  const error = useRemoteInstancesStore((state) => state.error);
  const busyById = useRemoteInstancesStore((state) => state.busyById);
  const fetchInstances = useRemoteInstancesStore((state) => state.fetchInstances);
  const selectInstance = useRemoteInstancesStore((state) => state.selectInstance);
  const sendRemoteMessage = useRemoteInstancesStore((state) => state.sendRemoteMessage);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    void fetchInstances();
  }, [fetchInstances]);

  const selectedInstance = useMemo(
    () => instances.find((instance) => instance.id === selectedInstanceId) ?? instances[0] ?? null,
    [instances, selectedInstanceId],
  );

  useEffect(() => {
    if (!selectedInstanceId && selectedInstance) {
      selectInstance(selectedInstance.id);
    }
  }, [selectedInstance, selectedInstanceId, selectInstance]);

  const title = selectedInstance
    ? formatSelectedTitle(selectedInstance.displayName || selectedInstance.agentCard?.name, '远程实例')
    : '远程实例';

  const selectedThread = selectedInstance
    ? threadsByInstanceId[selectedInstance.id] ?? {
        instanceId: selectedInstance.id,
        messages: [],
        contextId: null,
        taskId: null,
        updatedAt: null,
      }
    : null;
  const sending = selectedInstance ? Boolean(busyById[selectedInstance.id]?.sending) : false;

  return (
    <div className="flex h-full min-h-0 bg-white dark:bg-background">
      <RemoteInstanceList
        instances={instances}
        selectedInstanceId={selectedInstance?.id ?? null}
        loading={loading}
        onSelect={selectInstance}
        onRefresh={() => void fetchInstances({ force: true })}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-black/[0.06] bg-white px-5 dark:border-white/10 dark:bg-background">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[15px] font-semibold text-[#0f172a] dark:text-foreground">
                {title}
              </h1>
              {selectedInstance?.lastTest?.ok ? (
                <Badge variant="success">已连接</Badge>
              ) : (
                <Badge variant="secondary">独立工作区</Badge>
              )}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-[#64748b] dark:text-muted-foreground">
              远程实例会话保留在此工作区，不进入全局会话列表。
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => navigate('/settings?section=remote-instances')}
            >
              <Settings className="h-4 w-4" />
              设置
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setDetailsOpen(true)}
              disabled={!selectedInstance}
            >
              <Info className="h-4 w-4" />
              详情
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafafc] px-8 py-6 dark:bg-background">
          <div className="mx-auto flex min-h-full max-w-[980px] flex-col">
            {error ? (
              <div
                role="alert"
                className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-100"
              >
                {error}
              </div>
            ) : null}

            {!selectedInstance && loading ? (
              <div className="flex flex-1 items-center justify-center text-[13px] text-[#64748b] dark:text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在加载远程实例...
              </div>
            ) : null}

            {!selectedInstance && !loading ? (
              <section className="flex flex-1 flex-col items-center justify-center text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#e0f2fe] text-[#0369a1] dark:bg-sky-950/40 dark:text-sky-200">
                  <Network className="h-6 w-6" />
                </div>
                <h2 className="mt-4 text-[18px] font-semibold text-[#0f172a] dark:text-foreground">
                  还没有远程实例
                </h2>
                <p className="mt-2 max-w-[420px] text-[13px] leading-6 text-[#64748b] dark:text-muted-foreground">
                  先在设置中添加一个 Agent Card URL。这里会成为日常远程会话工作区。
                </p>
                <Button
                  type="button"
                  className="mt-5"
                  onClick={() => navigate('/settings?section=remote-instances')}
                >
                  添加远程实例
                </Button>
              </section>
            ) : null}

            {selectedInstance ? (
              <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-black/[0.06] bg-white shadow-sm dark:border-white/10 dark:bg-card">
                <RemoteInstanceConversation
                  instance={selectedInstance}
                  thread={selectedThread ?? {
                    instanceId: selectedInstance.id,
                    messages: [],
                    contextId: null,
                    taskId: null,
                    updatedAt: null,
                  }}
                  sending={sending}
                />
                <RemoteInstanceComposer
                  sending={sending}
                  disabled={!selectedInstance}
                  onSend={async (message) => {
                    await sendRemoteMessage(selectedInstance.id, { message });
                  }}
                />
              </section>
            ) : null}
          </div>
        </div>
      </main>

      <RemoteInstanceDetailsDrawer
        instance={selectedInstance}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </div>
  );
}

export default RemoteInstances;
