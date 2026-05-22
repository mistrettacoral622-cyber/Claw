import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  CheckCircle2,
  CircleDot,
  ChevronDown,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCcw,
  Save,
  SendHorizontal,
  Server,
  Settings2,
  Shield,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import type { RawMessage } from '@/stores/chat';
import {
  useIntercomStore,
  type IntercomSendResult,
  type IntercomRoute,
} from '@/stores/intercom';
import {
  buildSshPreview,
  DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND,
  DEFAULT_INTERCOM_ROUTE_ID,
  DEFAULT_INTERCOM_SESSION_ID,
  deriveIntercomRouteDraft,
  emptyIntercomRouteDraft,
  extractIntercomReplyMessages,
  normalizeIntercomPort,
  type IntercomRouteDraft,
} from './intercom-ui-utils';

type MessageDraft = {
  sender: string;
  message: string;
};

type IntercomRunDetail = {
  id: string;
  target: string;
  agent: string;
  exitCode: number | null;
  durationMs: number | null;
  commandPreview: string;
  stderr: string;
  stdout: string;
};

type IntercomConversation = {
  messages: RawMessage[];
  runs: IntercomRunDetail[];
};

function routeAddress(route: IntercomRoute): string {
  return route.sshUser ? `${route.sshUser}@${route.host}` : route.host;
}

function routeTransportLabel(route: IntercomRoute): string {
  if (route.transport === 'ssh') {
    return 'SSH';
  }
  if (route.transport === 'nats') {
    return 'NATS';
  }
  return 'Local';
}

function createIntercomMessage(role: RawMessage['role'], content: string, id: string): RawMessage {
  return {
    id,
    role,
    content,
  };
}

function createRunDetail(result: IntercomSendResult, id: string, commandPreview: string): IntercomRunDetail {
  return {
    id,
    target: result.target,
    agent: result.agent,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    commandPreview,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function buildAssistantMessages(result: IntercomSendResult, idPrefix: string): RawMessage[] {
  const messages = extractIntercomReplyMessages(result.stdout);
  if (messages.length > 0) {
    return messages.map((message, index) => ({
      ...message,
      id: message.id || `${idPrefix}-assistant-${index}`,
      role: message.role === 'user' ? 'assistant' : message.role,
    }));
  }
  if (result.exitCode && result.exitCode !== 0 && result.stderr.trim()) {
    return [createIntercomMessage('assistant', result.stderr.trim(), `${idPrefix}-assistant-error`)];
  }
  return [createIntercomMessage('assistant', `Command completed with exit code ${result.exitCode ?? 0}. Raw output is available in run details.`, `${idPrefix}-assistant`)];
}

export function IntercomControlConsole() {
  const { t } = useTranslation('settings');
  const routes = useIntercomStore((state) => state.routes);
  const localAgents = useIntercomStore((state) => state.localAgents);
  const loading = useIntercomStore((state) => state.loading);
  const saving = useIntercomStore((state) => state.saving);
  const sending = useIntercomStore((state) => state.sending);
  const installingProtocol = useIntercomStore((state) => state.installingProtocol);
  const fetchIntercom = useIntercomStore((state) => state.fetchIntercom);
  const upsertRoute = useIntercomStore((state) => state.upsertRoute);
  const sendMessage = useIntercomStore((state) => state.sendMessage);
  const installProtocol = useIntercomStore((state) => state.installProtocol);

  const sshRoutes = useMemo(
    () => routes.filter((route) => route.transport === 'ssh'),
    [routes],
  );
  const firstRoute = sshRoutes[0] ?? null;

  const [selectedRouteId, setSelectedRouteId] = useState<string>('');
  const [configOpen, setConfigOpen] = useState(false);
  const [routeDraft, setRouteDraft] = useState<IntercomRouteDraft>(() => emptyIntercomRouteDraft());
  const [messageDraft, setMessageDraft] = useState<MessageDraft>({
    sender: '',
    message: '',
  });
  const [conversations, setConversations] = useState<Record<string, IntercomConversation>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageSeqRef = useRef(0);

  const selectedRoute = sshRoutes.find((route) => route.id === selectedRouteId) ?? null;
  const previewDraft = selectedRoute ? deriveIntercomRouteDraft(selectedRoute) : routeDraft;
  const selectedConversation = selectedRouteId ? conversations[selectedRouteId] : undefined;
  const conversationMessages = selectedConversation?.messages ?? [];
  const runDetails = selectedConversation?.runs ?? [];
  const latestRun = runDetails.at(-1) ?? null;

  useEffect(() => {
    void fetchIntercom();
  }, [fetchIntercom]);

  useEffect(() => {
    setSelectedRouteId((current) => {
      if (sshRoutes.some((route) => route.id === current)) {
        return current;
      }
      return firstRoute?.id ?? '';
    });
  }, [firstRoute, sshRoutes]);

  useEffect(() => {
    setMessageDraft((current) => ({
      ...current,
      sender: localAgents.some((agent) => agent.id === current.sender)
        ? current.sender
        : localAgents[0]?.id || current.sender || 'main',
    }));
  }, [localAgents]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }
    if (typeof scrollElement.scrollTo === 'function') {
      scrollElement.scrollTo({
        top: scrollElement.scrollHeight,
        behavior: 'smooth',
      });
      return;
    }
    scrollElement.scrollTop = scrollElement.scrollHeight;
  }, [conversationMessages.length, sending, selectedRouteId]);

  const canSaveRoute =
    !saving &&
    Boolean(routeDraft.id.trim()) &&
    Boolean(routeDraft.host.trim()) &&
    Boolean(routeDraft.agent.trim());
  const canSend =
    !sending &&
    Boolean(messageDraft.sender.trim()) &&
    Boolean(selectedRoute) &&
    Boolean(messageDraft.message.trim());

  const openNewRouteConfig = () => {
    setRouteDraft(emptyIntercomRouteDraft());
    setConfigOpen(true);
  };

  const openRouteConfig = (route: IntercomRoute) => {
    setSelectedRouteId(route.id);
    setRouteDraft(deriveIntercomRouteDraft(route));
    setConfigOpen(true);
  };

  const handleSaveRoute = async () => {
    const nextId = routeDraft.id.trim();
    try {
      await upsertRoute({
        id: nextId,
        displayName: routeDraft.displayName.trim() || nextId,
        host: routeDraft.host.trim(),
        agent: routeDraft.agent.trim(),
        transport: 'ssh',
        sessionId: routeDraft.sessionId.trim() || DEFAULT_INTERCOM_SESSION_ID,
        enabled: true,
        sshUser: routeDraft.sshUser.trim() || undefined,
        sshPort: normalizeIntercomPort(routeDraft.sshPort),
        sshPassword: routeDraft.sshPassword || undefined,
        clearSshPassword: routeDraft.clearSshPassword,
        remoteCommand: routeDraft.remoteCommand.trim() || DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND,
      });
      setSelectedRouteId(nextId);
      setConfigOpen(false);
      toast.success(t('remoteInstances.intercom.toasts.routeSaved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.routeSaveFailed'));
    }
  };

  const handleSendMessage = async () => {
    if (!selectedRoute) {
      toast.error(t('remoteInstances.intercom.routeNeedsSave'));
      return;
    }
    const text = messageDraft.message.trim();
    if (!text) {
      return;
    }

    const routeId = selectedRoute.id;
    messageSeqRef.current += 1;
    const messageId = `${routeId}-${messageSeqRef.current}`;
    const commandPreview = buildSshPreview(previewDraft, text, messageDraft.sender.trim());
    setConversations((current) => {
      const conversation = current[routeId] ?? { messages: [], runs: [] };
      return {
        ...current,
        [routeId]: {
          ...conversation,
          messages: [
            ...conversation.messages,
            createIntercomMessage('user', text, `${messageId}-user`),
          ],
        },
      };
    });
    setMessageDraft((current) => ({ ...current, message: '' }));

    try {
      const result = await sendMessage({
        sender: messageDraft.sender.trim(),
        target: routeId,
        message: text,
        sessionId: selectedRoute.sessionId || DEFAULT_INTERCOM_SESSION_ID,
      });
      setConversations((current) => {
        const conversation = current[routeId] ?? { messages: [], runs: [] };
        return {
          ...current,
          [routeId]: {
            messages: [
              ...conversation.messages,
              ...buildAssistantMessages(result, messageId),
            ],
            runs: [
              ...conversation.runs,
              createRunDetail(result, `${messageId}-run`, commandPreview),
            ],
          },
        };
      });
      setDetailsOpen(false);
      toast.success(t('remoteInstances.intercom.toasts.messageDelivered', {
        code: result.exitCode ?? 0,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.messageFailed');
      setConversations((current) => {
        const conversation = current[routeId] ?? { messages: [], runs: [] };
        return {
          ...current,
          [routeId]: {
            ...conversation,
            messages: [
              ...conversation.messages,
              createIntercomMessage('assistant', message, `${messageId}-error`),
            ],
          },
        };
      });
      toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.messageFailed'));
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (canSend) {
      void handleSendMessage();
    }
  };

  const handleInstallProtocol = async () => {
    try {
      const result = await installProtocol();
      toast.success(t('remoteInstances.intercom.toasts.protocolInstalled', {
        updated: result.updated.length,
        skipped: result.skipped.length,
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.protocolFailed'));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f7f8fb] dark:bg-background">
      <header className="flex min-h-[64px] shrink-0 items-center justify-between gap-4 border-b border-black/[0.06] bg-white px-5 dark:border-white/10 dark:bg-card">
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold text-[#0f172a] dark:text-foreground">
            {t('remoteInstances.intercom.consoleTitle')}
          </h1>
          <p className="mt-1 text-[12px] text-[#64748b] dark:text-muted-foreground">
            {t('remoteInstances.intercom.consoleDescription')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void fetchIntercom({ force: true })}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            {t('remoteInstances.intercom.refresh')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void handleInstallProtocol()}
            disabled={installingProtocol}
          >
            {installingProtocol ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
            {t('remoteInstances.intercom.installProtocol')}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] overflow-hidden">
        <aside className="min-h-0 border-r border-black/[0.06] bg-white dark:border-white/10 dark:bg-card">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-black/[0.06] px-4 py-3 dark:border-white/10">
              <div>
                <p className="text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.intercom.instanceListTitle')}
                </p>
                <p className="mt-0.5 text-[11px] text-[#64748b] dark:text-muted-foreground">
                  {t('remoteInstances.intercom.instanceCount', { count: sshRoutes.length })}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('remoteInstances.intercom.newRoute')}
                onClick={openNewRouteConfig}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {sshRoutes.length === 0 ? (
                <div className="rounded-lg border border-dashed border-black/10 px-3 py-4 text-[12px] leading-5 text-[#64748b] dark:border-white/10 dark:text-muted-foreground">
                  {t('remoteInstances.intercom.emptyRoutes')}
                </div>
              ) : null}

              <div className="space-y-2">
                {sshRoutes.map((route) => {
                  const active = route.id === selectedRouteId;
                  return (
                    <div
                      key={route.id}
                      className={`rounded-lg border transition-colors ${
                        active
                          ? 'border-[#2563eb] bg-[#eff6ff] dark:border-blue-500/70 dark:bg-blue-950/30'
                          : 'border-transparent bg-transparent hover:border-black/5 hover:bg-[#f8fafc] dark:hover:border-white/10 dark:hover:bg-muted/40'
                      }`}
                    >
                      <div className="flex items-start gap-2 px-3 py-3">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setSelectedRouteId(route.id)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                                {route.displayName || route.id}
                              </p>
                              <p className="mt-1 truncate text-[11px] text-[#64748b] dark:text-muted-foreground">
                                {routeAddress(route)}
                              </p>
                            </div>
                            <Badge variant={route.enabled ? 'success' : 'secondary'}>
                              {routeTransportLabel(route)}
                            </Badge>
                          </div>
                          <div className="mt-3 flex items-center gap-2 text-[11px] text-[#64748b] dark:text-muted-foreground">
                            <CircleDot className="h-3.5 w-3.5" />
                            <span className="truncate">
                              {route.agent} / {route.sessionId || DEFAULT_INTERCOM_SESSION_ID}
                            </span>
                          </div>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t('remoteInstances.intercom.configureRoute')}
                          onClick={() => openRouteConfig(route)}
                        >
                          <Settings2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-white dark:bg-card">
          <div className="shrink-0 border-b border-black/[0.06] px-5 py-4 dark:border-white/10">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MessageSquareText className="h-4 w-4 text-[#64748b] dark:text-muted-foreground" />
                <h2 className="text-[15px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.intercom.chatTitle')}
                </h2>
              </div>
              <Badge variant={selectedRoute ? 'success' : 'warning'}>
                {selectedRoute ? t('remoteInstances.intercom.routeReady') : t('remoteInstances.intercom.routeNeedsSave')}
              </Badge>
            </div>
            <p className="mt-1 text-[12px] text-[#64748b] dark:text-muted-foreground">
              {selectedRoute
                ? `${selectedRoute.displayName || selectedRoute.id} - ${routeAddress(selectedRoute)}`
                : t('remoteInstances.intercom.chatNeedsRoute')}
            </p>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-[#fafafc] px-6 py-5 dark:bg-background">
            <div className="mx-auto flex min-h-full max-w-[960px] flex-col gap-4">
              {conversationMessages.length === 0 ? (
                <div className="flex min-h-[320px] flex-1 items-center justify-center">
                  <div className="max-w-sm text-center">
                    <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-[#64748b] shadow-[0_1px_2px_rgba(0,0,0,0.05)] dark:bg-card dark:text-muted-foreground">
                      <MessageSquareText className="h-5 w-5" />
                    </div>
                    <p className="mt-3 text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                      {selectedRoute
                        ? `${selectedRoute.displayName || selectedRoute.id} / ${selectedRoute.agent}`
                        : t('remoteInstances.intercom.chatNeedsRoute')}
                    </p>
                    <p className="mt-1 text-[12px] text-[#64748b] dark:text-muted-foreground">
                      {selectedRoute ? routeAddress(selectedRoute) : t('remoteInstances.intercom.routeNeedsSave')}
                    </p>
                  </div>
                </div>
              ) : (
                conversationMessages.map((message) => (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    showThinking={false}
                  />
                ))
              )}

              {sending ? (
                <ChatMessage
                  message={{
                    id: `${selectedRouteId || 'route'}-pending`,
                    role: 'assistant',
                    content: t('remoteInstances.intercom.readyToSend'),
                  }}
                  showThinking={false}
                  isStreaming
                />
              ) : null}

              {latestRun ? (
                <div className="ml-11 rounded-xl border border-black/[0.06] bg-white/80 px-3 py-2 text-[11px] text-[#64748b] shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-card/80 dark:text-muted-foreground">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 text-left"
                    onClick={() => setDetailsOpen((value) => !value)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      <span className="truncate">
                        {t('remoteInstances.intercom.exitCodeLabel')}: {latestRun.exitCode ?? '-'} / {t('remoteInstances.intercom.durationLabel')}: {latestRun.durationMs ?? '-'}ms
                      </span>
                    </span>
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {detailsOpen ? (
                    <div className="mt-3 space-y-3">
                      <p className="break-all font-mono text-[10px] leading-4 text-[#64748b] dark:text-muted-foreground">
                        {latestRun.commandPreview}
                      </p>
                      <div>
                        <p className="font-medium uppercase tracking-[0.04em]">stdout</p>
                        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-[#f8fafc] px-3 py-2 font-mono text-[10px] leading-4 text-[#0f172a] dark:bg-background dark:text-foreground">
                          {latestRun.stdout || t('remoteInstances.intercom.emptyOutput')}
                        </pre>
                      </div>
                      {latestRun.stderr ? (
                        <div>
                          <p className="font-medium uppercase tracking-[0.04em]">stderr</p>
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-[#f8fafc] px-3 py-2 font-mono text-[10px] leading-4 text-[#0f172a] dark:bg-background dark:text-foreground">
                            {latestRun.stderr}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <footer className="shrink-0 border-t border-black/[0.06] bg-white px-5 pb-5 pt-4 dark:border-white/10 dark:bg-card">
            <div className="mx-auto max-w-[960px]">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <label className="inline-flex max-w-full shrink-0 items-center gap-2 text-[12px] text-[#64748b] dark:text-muted-foreground">
                  <span className="shrink-0 whitespace-nowrap">{t('remoteInstances.intercom.senderLabel')}</span>
                  <span className="relative inline-flex h-9 w-[124px] items-center rounded-full border border-black/10 bg-[#f8fafc] px-4 text-[13px] font-medium text-[#0f172a] dark:border-white/10 dark:bg-background dark:text-foreground">
                    <span className="min-w-0 flex-1 truncate">
                      {messageDraft.sender || localAgents[0]?.id || 'main'}
                    </span>
                    <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-[#64748b] dark:text-muted-foreground" />
                    <Select
                      aria-label="Sender agent"
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      value={messageDraft.sender}
                      onChange={(event) => setMessageDraft((current) => ({ ...current, sender: event.target.value }))}
                    >
                      {localAgents.length === 0 ? <option value="main">main</option> : null}
                      {localAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name || agent.id}
                        </option>
                      ))}
                    </Select>
                  </span>
                </label>
                <div className="flex min-w-0 items-center gap-2 text-[12px] text-[#64748b] dark:text-muted-foreground">
                  {selectedRoute ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <Server className="h-4 w-4 shrink-0 text-amber-600" />
                  )}
                  <span className="truncate">
                    {selectedRoute
                      ? t('remoteInstances.intercom.readyToSend')
                      : t('remoteInstances.intercom.routeNeedsSave')}
                  </span>
                </div>
              </div>

              <div className="flex items-end gap-3 rounded-[22px] border border-black/10 bg-[#f7f7f9] px-4 py-3 shadow-[0_4px_18px_rgba(15,23,42,0.06)] focus-within:border-[#0a84ff]/50 dark:border-white/10 dark:bg-background">
                <Textarea
                  aria-label="Intercom message"
                  className="min-h-[24px] max-h-[160px] flex-1 resize-none border-0 bg-transparent px-0 py-0 text-[14px] leading-6 text-[#0f172a] shadow-none placeholder:text-[#8e8e93] focus-visible:ring-0 focus-visible:ring-offset-0 dark:text-foreground"
                  rows={1}
                  placeholder={t('remoteInstances.intercom.messagePlaceholder')}
                  value={messageDraft.message}
                  onChange={(event) => setMessageDraft((current) => ({ ...current, message: event.target.value }))}
                  onKeyDown={handleComposerKeyDown}
                  disabled={!selectedRoute}
                />
                <Button
                  type="button"
                  size="icon"
                  className={`h-9 w-9 shrink-0 rounded-full transition-opacity ${
                    canSend || sending
                      ? 'bg-[#10b981] text-white hover:bg-[#059669]'
                      : 'bg-transparent text-muted-foreground/50 hover:bg-transparent'
                  }`}
                  variant="ghost"
                  onClick={() => void handleSendMessage()}
                  disabled={!canSend}
                  aria-label={t('remoteInstances.intercom.send')}
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </footer>
        </section>
      </div>

      <Sheet open={configOpen} onOpenChange={setConfigOpen}>
        <SheetContent side="right" className="flex w-full flex-col overflow-y-auto sm:max-w-[460px]">
          <SheetHeader>
            <SheetTitle>{t('remoteInstances.intercom.configureTitle')}</SheetTitle>
            <SheetDescription>
              {t('remoteInstances.intercom.configSheetDescription')}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="space-y-2 md:col-span-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.hostLabel')}
              </span>
              <Input
                aria-label="Linux host"
                placeholder="10.101.208.178"
                value={routeDraft.host}
                onChange={(event) => setRouteDraft((current) => ({ ...current, host: event.target.value }))}
              />
            </label>

            <label className="space-y-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.sshUserLabel')}
              </span>
              <Input
                aria-label="SSH user"
                placeholder="root"
                value={routeDraft.sshUser}
                onChange={(event) => setRouteDraft((current) => ({ ...current, sshUser: event.target.value }))}
              />
            </label>

            <label className="space-y-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.sshPortLabel')}
              </span>
              <Input
                aria-label="SSH port"
                inputMode="numeric"
                placeholder="22"
                value={routeDraft.sshPort}
                onChange={(event) => setRouteDraft((current) => ({ ...current, sshPort: event.target.value }))}
              />
            </label>

            <label className="space-y-2 md:col-span-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.sshPasswordLabel')}
              </span>
              <Input
                aria-label="SSH password"
                type="password"
                placeholder={routeDraft.sshPasswordConfigured && !routeDraft.clearSshPassword
                  ? t('remoteInstances.intercom.passwordSavedPlaceholder')
                  : t('remoteInstances.intercom.optionalPlaceholder')}
                value={routeDraft.sshPassword}
                onChange={(event) => setRouteDraft((current) => ({
                  ...current,
                  sshPassword: event.target.value,
                  clearSshPassword: false,
                }))}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] leading-5 text-[#64748b] dark:text-muted-foreground">
                  {routeDraft.sshPasswordConfigured && !routeDraft.clearSshPassword
                    ? t('remoteInstances.intercom.passwordSavedHint')
                    : t('remoteInstances.intercom.passwordOptionalHint')}
                </p>
                {routeDraft.sshPasswordConfigured ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-2 text-red-600 hover:text-red-700 dark:text-red-400"
                    onClick={() => setRouteDraft((current) => ({
                      ...current,
                      sshPassword: '',
                      clearSshPassword: true,
                    }))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('remoteInstances.intercom.clearPassword')}
                  </Button>
                ) : null}
              </div>
            </label>

            <label className="space-y-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.agentIdLabel')}
              </span>
              <Input
                aria-label="Linux agent id"
                placeholder="main"
                value={routeDraft.agent}
                onChange={(event) => setRouteDraft((current) => ({ ...current, agent: event.target.value }))}
              />
            </label>

            <label className="space-y-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.sessionLabel')}
              </span>
              <Input
                aria-label="Intercom session"
                placeholder="intercom"
                value={routeDraft.sessionId}
                onChange={(event) => setRouteDraft((current) => ({ ...current, sessionId: event.target.value }))}
              />
            </label>

            <label className="space-y-2 md:col-span-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.remoteCommandLabel')}
              </span>
              <Input
                aria-label="Remote OpenClaw command"
                placeholder={DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND}
                value={routeDraft.remoteCommand}
                onChange={(event) => setRouteDraft((current) => ({ ...current, remoteCommand: event.target.value }))}
              />
            </label>

            <label className="space-y-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.routeIdLabel')}
              </span>
              <Input
                aria-label="Route ID"
                placeholder={DEFAULT_INTERCOM_ROUTE_ID}
                value={routeDraft.id}
                onChange={(event) => setRouteDraft((current) => ({ ...current, id: event.target.value }))}
              />
            </label>

            <label className="space-y-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.displayNameLabel')}
              </span>
              <Input
                aria-label="Display name"
                value={routeDraft.displayName}
                onChange={(event) => setRouteDraft((current) => ({ ...current, displayName: event.target.value }))}
              />
            </label>
          </div>

          <SheetFooter className="mt-5">
            <Button
              type="button"
              className="gap-2"
              onClick={() => void handleSaveRoute()}
              disabled={!canSaveRoute}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t('remoteInstances.intercom.saveRoute')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
