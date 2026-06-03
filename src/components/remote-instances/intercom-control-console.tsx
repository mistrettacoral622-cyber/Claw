import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type SetStateAction } from 'react';
import {
  CheckCircle2,
  Camera,
  CircleDot,
  ChevronDown,
  ClipboardPaste,
  FileText,
  Loader2,
  MessageSquareText,
  Monitor,
  Paperclip,
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
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import type { AttachedFileMeta, RawMessage } from '@/stores/chat';
import {
  useIntercomStore,
  type IntercomRemoteTaskArtifact,
  type IntercomSendResult,
  type IntercomRoute,
  type IntercomTaskSendResult,
  type IntercomTransferRecord,
} from '@/stores/intercom';
import {
  buildSshPreview,
  DEFAULT_LINUX_KTCLAW_REMOTE_COMMAND,
  DEFAULT_INTERCOM_ROUTE_ID,
  DEFAULT_INTERCOM_SESSION_ID,
  deriveIntercomRouteDraft,
  emptyIntercomRouteDraft,
  extractIntercomReplyMessages,
  looksLikeStructuredIntercomOutput,
  normalizeIntercomPort,
  parseIntercomConnectionShare,
  type IntercomRouteDraft,
} from './intercom-ui-utils';

type MessageDraft = {
  sender: string;
  message: string;
};

type StagedRemoteFile = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
  status: 'staging' | 'ready' | 'uploading' | 'uploaded' | 'error';
  remotePath?: string;
  error?: string;
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
  taskResult?: IntercomTaskSendResult['result'];
  transfers?: IntercomTransferRecord[];
};

type IntercomConversation = {
  messages: RawMessage[];
  runs: IntercomRunDetail[];
};

type IntercomConversationMap = Record<string, IntercomConversation>;

const INTERCOM_CONVERSATIONS_STORAGE_KEY = 'ktclaw:intercom-control-conversations';
const MAX_STORED_INTERCOM_MESSAGES_PER_ROUTE = 100;
const MAX_STORED_INTERCOM_RUNS_PER_ROUTE = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStoredConversation(value: unknown): IntercomConversation {
  const row = isRecord(value) ? value : {};
  const messages = Array.isArray(row.messages)
    ? row.messages
        .filter((message) => (
          isRecord(message)
          && typeof message.role === 'string'
          && ('content' in message)
        ))
        .map((message) => message as unknown as RawMessage)
    : [];
  const runs = Array.isArray(row.runs)
    ? row.runs.filter(isRecord).map((run) => run as IntercomRunDetail)
    : [];
  return {
    messages: messages.slice(-MAX_STORED_INTERCOM_MESSAGES_PER_ROUTE),
    runs: runs.slice(-MAX_STORED_INTERCOM_RUNS_PER_ROUTE),
  };
}

function trimIntercomConversations(conversations: IntercomConversationMap): IntercomConversationMap {
  return Object.fromEntries(Object.entries(conversations).map(([routeId, conversation]) => [
    routeId,
    {
      messages: conversation.messages.slice(-MAX_STORED_INTERCOM_MESSAGES_PER_ROUTE),
      runs: conversation.runs.slice(-MAX_STORED_INTERCOM_RUNS_PER_ROUTE),
    },
  ]));
}

function readStoredIntercomConversations(): IntercomConversationMap {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(INTERCOM_CONVERSATIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!isRecord(parsed)) {
      return {};
    }
    return trimIntercomConversations(Object.fromEntries(Object.entries(parsed).map(([routeId, conversation]) => [
      routeId,
      normalizeStoredConversation(conversation),
    ])));
  } catch {
    return {};
  }
}

function writeStoredIntercomConversations(conversations: IntercomConversationMap): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(
      INTERCOM_CONVERSATIONS_STORAGE_KEY,
      JSON.stringify(trimIntercomConversations(conversations)),
    );
  } catch {
    // Losing persisted UI history is preferable to blocking remote task sends.
  }
}

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

function createTaskRunDetail(
  result: IntercomTaskSendResult,
  id: string,
  commandPreview: string,
  transfers: IntercomTransferRecord[],
): IntercomRunDetail {
  return {
    ...createRunDetail(result, id, commandPreview),
    taskResult: result.result,
    transfers,
  };
}

function dedupeIntercomMessages(messages: RawMessage[]): RawMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const contentKey = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content ?? '');
    const key = `${message.role}:${contentKey}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildAssistantMessages(result: IntercomSendResult, idPrefix: string): RawMessage[] {
  const outputs = [result.stdout];
  const successfulRun = result.exitCode === 0 || result.exitCode === null;
  if (successfulRun && looksLikeStructuredIntercomOutput(result.stderr)) {
    outputs.push(result.stderr);
  }
  const messages = dedupeIntercomMessages(outputs.flatMap((output) => extractIntercomReplyMessages(output)));
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
  return [];
}

function buildTaskAssistantMessage(
  result: IntercomTaskSendResult,
  downloadedTransfers: IntercomTransferRecord[],
  idPrefix: string,
): RawMessage {
  const attachments: AttachedFileMeta[] = downloadedTransfers
    .filter((transfer) => transfer.status === 'success' && transfer.localPath)
    .map((transfer) => ({
      fileName: transfer.fileName,
      mimeType: transfer.mimeType || 'application/octet-stream',
      fileSize: transfer.size || 0,
      preview: null,
      filePath: transfer.localPath,
    }));
  return {
    id: `${idPrefix}-task-result`,
    role: 'assistant',
    content: result.result.summary
      || result.result.error
      || (result.result.success ? 'Remote task completed.' : 'Remote task failed.'),
    isError: !result.result.success,
    _attachedFiles: attachments.length > 0 ? attachments : undefined,
  };
}

function makeTaskId(routeId: string): string {
  return `task-${routeIdPart(routeId, 'route')}-${Date.now().toString(36)}`;
}

async function stageDialogFiles(): Promise<StagedRemoteFile[]> {
  const result = await invokeIpc<{ canceled: boolean; filePaths?: string[] }>('dialog:open', {
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths?.length) {
    return [];
  }

  return hostApiFetch<Array<{
    id: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    stagedPath: string;
    preview: string | null;
  }>>('/api/files/stage-paths', {
    method: 'POST',
    body: JSON.stringify({ filePaths: result.filePaths }),
  }).then((files) => files.map((file) => ({
    ...file,
    status: 'ready' as const,
  })));
}

function artifactToDownloadInput(artifact: IntercomRemoteTaskArtifact) {
  return {
    path: artifact.path,
    type: artifact.type,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
  };
}

function routeIdPart(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function deriveRouteIdFromDraft(route: IntercomRouteDraft): string {
  const explicitId = route.id.trim();
  if (explicitId) {
    return explicitId;
  }
  const host = routeIdPart(route.host, 'remote');
  const agent = routeIdPart(route.agent, 'main');
  return `${host}-${agent}`;
}

function deriveDisplayNameFromDraft(route: IntercomRouteDraft, routeId: string): string {
  const explicitName = route.displayName.trim();
  if (explicitName) {
    return explicitName;
  }
  const host = route.host.trim();
  const agent = route.agent.trim() || 'main';
  return host ? `${host} / ${agent}` : routeId;
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
  const sendTask = useIntercomStore((state) => state.sendTask);
  const uploadFiles = useIntercomStore((state) => state.uploadFiles);
  const downloadArtifacts = useIntercomStore((state) => state.downloadArtifacts);
  const installProtocol = useIntercomStore((state) => state.installProtocol);

  const sshRoutes = useMemo(
    () => routes.filter((route) => route.transport === 'ssh'),
    [routes],
  );
  const firstRoute = sshRoutes[0] ?? null;

  const [selectedRouteId, setSelectedRouteId] = useState<string>('');
  const [configOpen, setConfigOpen] = useState(false);
  const [advancedConfigOpen, setAdvancedConfigOpen] = useState(false);
  const [routeDraft, setRouteDraft] = useState<IntercomRouteDraft>(() => emptyIntercomRouteDraft());
  const [messageDraft, setMessageDraft] = useState<MessageDraft>({
    sender: '',
    message: '',
  });
  const [stagedFiles, setStagedFiles] = useState<StagedRemoteFile[]>([]);
  const [conversations, setConversationsState] = useState<IntercomConversationMap>(() => readStoredIntercomConversations());
  const setConversations = useCallback((updater: SetStateAction<IntercomConversationMap>) => {
    setConversationsState((current) => {
      const next = trimIntercomConversations(
        typeof updater === 'function'
          ? (updater as (value: IntercomConversationMap) => IntercomConversationMap)(current)
          : updater,
      );
      writeStoredIntercomConversations(next);
      return next;
    });
  }, []);
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
    Boolean(routeDraft.host.trim()) &&
    Boolean(routeDraft.agent.trim());
  const hasSendableFiles = stagedFiles.some((file) => file.status === 'ready' || file.status === 'uploaded');
  const canSend =
    !sending &&
    Boolean(messageDraft.sender.trim()) &&
    Boolean(selectedRoute) &&
    Boolean(messageDraft.message.trim());
  const canSendTask =
    !sending &&
    Boolean(messageDraft.sender.trim()) &&
    Boolean(selectedRoute) &&
    (Boolean(messageDraft.message.trim()) || hasSendableFiles);
  const canPrimarySend = hasSendableFiles ? canSendTask : canSend;

  const openNewRouteConfig = () => {
    setRouteDraft(emptyIntercomRouteDraft());
    setAdvancedConfigOpen(false);
    setConfigOpen(true);
  };

  const openRouteConfig = (route: IntercomRoute) => {
    setSelectedRouteId(route.id);
    setRouteDraft(deriveIntercomRouteDraft(route));
    setAdvancedConfigOpen(false);
    setConfigOpen(true);
  };

  const handleSaveRoute = async () => {
    const nextId = deriveRouteIdFromDraft(routeDraft);
    const nextAgent = routeDraft.agent.trim() || 'main';
    const nextSessionId = routeDraft.sessionId.trim() || DEFAULT_INTERCOM_SESSION_ID;
    try {
      await upsertRoute({
        id: nextId,
        displayName: deriveDisplayNameFromDraft(routeDraft, nextId),
        host: routeDraft.host.trim(),
        agent: nextAgent,
        transport: 'ssh',
        sessionId: nextSessionId,
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

  const handlePasteConnectionInfo = async () => {
    try {
      if (!navigator.clipboard?.readText) {
        toast.error(t('remoteInstances.intercom.toasts.connectionInfoPasteFailed'));
        return;
      }
      const text = await navigator.clipboard?.readText?.();
      const parsed = parseIntercomConnectionShare(text ?? '');
      if (!parsed) {
        toast.error(t('remoteInstances.intercom.toasts.connectionInfoPasteFailed'));
        return;
      }
      setRouteDraft((current) => ({
        ...current,
        ...parsed,
        sshPassword: current.sshPassword,
        clearSshPassword: current.clearSshPassword,
        sshPasswordConfigured: current.sshPasswordConfigured,
      }));
      toast.success(t('remoteInstances.intercom.toasts.connectionInfoPasted'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.connectionInfoPasteFailed'));
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

  const handlePickFiles = async () => {
    try {
      const files = await stageDialogFiles();
      if (files.length === 0) {
        return;
      }
      setStagedFiles((current) => [...current, ...files]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.fileStageFailed'));
    }
  };

  const handleSendTask = async (options?: { screenshot?: boolean; camera?: boolean }) => {
    if (!selectedRoute) {
      toast.error(t('remoteInstances.intercom.routeNeedsSave'));
      return;
    }

    const routeId = selectedRoute.id;
    const sender = messageDraft.sender.trim();
    const taskId = makeTaskId(routeId);
    const taskText = options?.screenshot
      ? t('remoteInstances.intercom.screenshotTaskPrompt')
      : options?.camera
        ? t('remoteInstances.intercom.cameraTaskPrompt')
      : messageDraft.message.trim();
    if (!taskText && stagedFiles.length === 0 && !options?.screenshot && !options?.camera) {
      return;
    }

    messageSeqRef.current += 1;
    const messageId = `${routeId}-${messageSeqRef.current}`;
    setConversations((current) => {
      const conversation = current[routeId] ?? { messages: [], runs: [] };
      return {
        ...current,
        [routeId]: {
          ...conversation,
          messages: [
            ...conversation.messages,
            createIntercomMessage('user', taskText || t('remoteInstances.intercom.remoteTaskLabel'), `${messageId}-user`),
          ],
        },
      };
    });

    let uploadedTransfers: IntercomTransferRecord[] = [];
    try {
      const readyFiles = stagedFiles.filter((file) => file.status === 'ready' || file.status === 'uploaded');
      if (readyFiles.length > 0) {
        setStagedFiles((current) => current.map((file) => readyFiles.some((ready) => ready.id === file.id)
          ? { ...file, status: 'uploading' as const }
          : file));
        uploadedTransfers = await uploadFiles({
          target: routeId,
          sender,
          taskId,
          files: readyFiles.map((file) => ({
            localPath: file.stagedPath,
            fileName: file.fileName,
            mimeType: file.mimeType,
            size: file.fileSize,
          })),
        });
        setStagedFiles((current) => current.map((file) => {
          const transfer = uploadedTransfers.find((entry) => entry.fileName === file.fileName);
          return transfer
            ? { ...file, status: 'uploaded' as const, remotePath: transfer.remotePath }
            : file;
        }));
      }

      const outbox = `~/.ktclaw/intercom/outbox/${taskId}/`;
      const action = options?.screenshot ? 'screenshot' : options?.camera ? 'camera' : 'remote_task';
      const payload = options?.screenshot
        ? { outbox, format: 'png' }
        : options?.camera
          ? { outbox, format: 'jpg', reason: taskText }
        : {
            instruction: taskText,
            inboxFiles: uploadedTransfers.map((transfer) => ({
              name: transfer.fileName,
              path: transfer.remotePath,
              mimeType: transfer.mimeType,
              size: transfer.size,
            })),
            outbox,
          };
      const result = await sendTask({
        target: routeId,
        sender,
        taskId,
        action,
        payload,
        return: ['summary', 'artifacts', 'logs'],
        sessionId: selectedRoute.sessionId || DEFAULT_INTERCOM_SESSION_ID,
      });
      const downloadedTransfers = result.result.artifacts.length > 0
        ? await downloadArtifacts({
            target: routeId,
            taskId,
            artifacts: result.result.artifacts.map(artifactToDownloadInput),
          }).catch((error) => {
            toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.artifactDownloadFailed'));
            return [] as IntercomTransferRecord[];
          })
        : [];
      setConversations((current) => {
        const conversation = current[routeId] ?? { messages: [], runs: [] };
        return {
          ...current,
          [routeId]: {
            messages: [
              ...conversation.messages,
              buildTaskAssistantMessage(result, downloadedTransfers, messageId),
            ],
            runs: [
              ...conversation.runs,
              createTaskRunDetail(
                result,
                `${messageId}-run`,
                buildSshPreview(previewDraft, JSON.stringify(result.task), sender),
                [...uploadedTransfers, ...downloadedTransfers],
              ),
            ],
          },
        };
      });
      setMessageDraft((current) => ({ ...current, message: '' }));
      setStagedFiles([]);
      setDetailsOpen(false);
      toast.success(t('remoteInstances.intercom.toasts.taskDelivered'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.taskFailed');
      setStagedFiles((current) => current.map((file) => (
        file.status === 'uploading' ? { ...file, status: 'error' as const, error: message } : file
      )));
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
      toast.error(message);
    }
  };

  const handlePrimarySend = async () => {
    if (hasSendableFiles) {
      await handleSendTask();
      return;
    }
    await handleSendMessage();
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (canPrimarySend) {
      void handlePrimarySend();
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
                      {latestRun.taskResult ? (
                        <div>
                          <p className="font-medium uppercase tracking-[0.04em]">
                            {t('remoteInstances.intercom.taskResultLabel')}
                          </p>
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-[#f8fafc] px-3 py-2 font-mono text-[10px] leading-4 text-[#0f172a] dark:bg-background dark:text-foreground">
                            {JSON.stringify(latestRun.taskResult, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                      {latestRun.transfers?.length ? (
                        <div>
                          <p className="font-medium uppercase tracking-[0.04em]">
                            {t('remoteInstances.intercom.transferDetailsLabel')}
                          </p>
                          <div className="mt-1 space-y-1">
                            {latestRun.transfers.map((transfer) => (
                              <div key={transfer.id} className="flex items-center justify-between gap-3 rounded-lg bg-[#f8fafc] px-3 py-2 dark:bg-background">
                                <span className="min-w-0 truncate">
                                  {transfer.direction} / {transfer.fileName}
                                </span>
                                <span className={transfer.status === 'success' ? 'text-emerald-600' : 'text-red-600'}>
                                  {transfer.status}
                                </span>
                              </div>
                            ))}
                          </div>
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

              {stagedFiles.length > 0 ? (
                <div className="mb-3 flex flex-wrap gap-2">
                  {stagedFiles.map((file) => (
                    <div
                      key={file.id}
                      className="flex max-w-[220px] items-center gap-2 rounded-lg border border-black/10 bg-[#f8fafc] px-3 py-2 text-[12px] text-[#0f172a] dark:border-white/10 dark:bg-background dark:text-foreground"
                      title={file.remotePath || file.stagedPath}
                    >
                      {file.status === 'uploading' || file.status === 'staging'
                        ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#64748b]" />
                        : <FileText className="h-4 w-4 shrink-0 text-[#64748b]" />}
                      <span className="min-w-0 flex-1 truncate">{file.fileName}</span>
                      <span className={file.status === 'error' ? 'text-red-600' : 'text-[#64748b] dark:text-muted-foreground'}>
                        {file.status}
                      </span>
                      <button
                        type="button"
                        className="text-[#64748b] hover:text-red-600"
                        aria-label={t('remoteInstances.intercom.removeAttachment')}
                        onClick={() => setStagedFiles((current) => current.filter((entry) => entry.id !== file.id))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => void handlePickFiles()}
                  disabled={!selectedRoute || sending}
                >
                  <Paperclip className="h-4 w-4" />
                  {t('remoteInstances.intercom.attachFiles')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => void handleSendTask({ screenshot: true })}
                  disabled={!selectedRoute || sending}
                >
                  <Monitor className="h-4 w-4" />
                  {t('remoteInstances.intercom.screenshot')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => void handleSendTask({ camera: true })}
                  disabled={!selectedRoute || sending}
                >
                  <Camera className="h-4 w-4" />
                  {t('remoteInstances.intercom.camera')}
                </Button>
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
                    canPrimarySend || sending
                      ? 'bg-[#10b981] text-white hover:bg-[#059669]'
                      : 'bg-transparent text-muted-foreground/50 hover:bg-transparent'
                  }`}
                  variant="ghost"
                  onClick={() => void handlePrimarySend()}
                  disabled={!canPrimarySend}
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

          <div className="mt-5 rounded-lg border border-black/[0.04] bg-[#f8fafc] px-3 py-3 dark:border-white/10 dark:bg-muted/40">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.intercom.pasteConnectionInfoTitle')}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-[#64748b] dark:text-muted-foreground">
                  {t('remoteInstances.intercom.pasteConnectionInfoDescription')}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => void handlePasteConnectionInfo()}
              >
                <ClipboardPaste className="h-4 w-4" />
                {t('remoteInstances.intercom.pasteConnectionInfo')}
              </Button>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="space-y-2 md:col-span-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.hostLabel')}
              </span>
              <Input
                aria-label="Remote host"
                placeholder="10.101.208.178"
                value={routeDraft.host}
                onChange={(event) => setRouteDraft((current) => ({ ...current, host: event.target.value }))}
              />
            </label>

            <label className="space-y-2 md:col-span-2">
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

            <label className="space-y-2 md:col-span-2">
              <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.intercom.agentIdLabel')}
              </span>
              <Input
                aria-label="Remote agent id"
                placeholder="main"
                value={routeDraft.agent}
                onChange={(event) => setRouteDraft((current) => ({ ...current, agent: event.target.value }))}
              />
            </label>

            <div className="md:col-span-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-2 px-0 text-[#64748b] hover:bg-transparent hover:text-[#0f172a] dark:text-muted-foreground dark:hover:text-foreground"
                onClick={() => setAdvancedConfigOpen((value) => !value)}
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${advancedConfigOpen ? 'rotate-180' : ''}`} />
                {advancedConfigOpen
                  ? t('remoteInstances.intercom.hideAdvancedConfig')
                  : t('remoteInstances.intercom.showAdvancedConfig')}
              </Button>
            </div>

            {advancedConfigOpen ? (
              <>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.intercom.displayNameLabel')}
                  </span>
                  <Input
                    aria-label="Display name"
                    placeholder={deriveDisplayNameFromDraft({ ...routeDraft, displayName: '' }, deriveRouteIdFromDraft(routeDraft))}
                    value={routeDraft.displayName}
                    onChange={(event) => setRouteDraft((current) => ({ ...current, displayName: event.target.value }))}
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

                <label className="space-y-2 md:col-span-2">
                  <span className="text-[12px] font-medium text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.intercom.routeIdLabel')}
                  </span>
                  <Input
                    aria-label="Route ID"
                    placeholder={deriveRouteIdFromDraft({ ...routeDraft, id: '' }) || DEFAULT_INTERCOM_ROUTE_ID}
                    value={routeDraft.id}
                    onChange={(event) => setRouteDraft((current) => ({ ...current, id: event.target.value }))}
                  />
                </label>
              </>
            ) : null}
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
