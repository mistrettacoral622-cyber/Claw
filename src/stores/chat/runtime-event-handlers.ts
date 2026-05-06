import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  collectToolUpdates,
  extractImagesAsAttachedFiles,
  extractMediaRefs,
  extractRawFilePaths,
  getMessageText,
  getToolCallFilePath,
  hasErrorRecoveryTimer,
  hasNonToolAssistantContent,
  isToolOnlyMessage,
  isToolResultRole,
  makeAttachedFile,
  setErrorRecoveryTimer,
  upsertToolStatuses,
} from './helpers';
import type { AttachedFileMeta, RawMessage } from './types';
import type { ChatGet, ChatSet } from './store-api';

function isImageUnderstandingErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('image')
    || normalized.includes('vision')
    || normalized.includes('multimodal')
    || normalized.includes('image_url')
    || normalized.includes('content[1]')
    || normalized.includes('content type');
}

function isImageNetworkErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('network connection error')
    || normalized.includes('network error')
    || normalized.includes('llm request failed')
    || normalized.includes('fetch failed')
    || normalized.includes('econn')
    || normalized.includes('timeout');
}

function hasRecentUserImageMessage(messages: RawMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') {
      continue;
    }
    const attachedFiles = message._attachedFiles || [];
    return attachedFiles.some((file) => file.mimeType.startsWith('image/'));
  }
  return false;
}

function normalizeRuntimeErrorMessage(message: string, hasImages: boolean): string {
  if (hasImages && isImageUnderstandingErrorMessage(message)) {
    return '该模型暂时不能识别图片哦。';
  }
  if (hasImages && isImageNetworkErrorMessage(message)) {
    return '拍照识别失败：当前图片识别请求的网络或 Provider 连接不可用。请检查视觉模型、API Key、代理或网络连接后重试。';
  }
  return message;
}

export function handleRuntimeEventState(
  set: ChatSet,
  get: ChatGet,
  event: Record<string, unknown>,
  resolvedState: string,
  runId: string,
): void {
  switch (resolvedState) {
    case 'started': {
      const { sending: currentSending } = get();
      if (!currentSending && runId) {
        set({ sending: true, activeRunId: runId, error: null });
      }
      break;
    }
    case 'delta': {
      if (hasErrorRecoveryTimer()) {
        clearErrorRecoveryTimer();
        set({ error: null });
      }
      const updates = collectToolUpdates(event.message, resolvedState);
      set((s) => ({
        streamingMessage: (() => {
          if (event.message && typeof event.message === 'object') {
            const msgRole = (event.message as RawMessage).role;
            if (isToolResultRole(msgRole)) return s.streamingMessage;
          }
          return event.message ?? s.streamingMessage;
        })(),
        streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
      }));
      break;
    }
    case 'final': {
      clearErrorRecoveryTimer();
      if (get().error) set({ error: null });
      const finalMsg = event.message as RawMessage | undefined;
      if (finalMsg) {
        const updates = collectToolUpdates(finalMsg, resolvedState);
        if (isToolResultRole(finalMsg.role)) {
          const currentStreamForPath = get().streamingMessage as RawMessage | null;
          const matchedPath = (currentStreamForPath && finalMsg.toolCallId)
            ? getToolCallFilePath(currentStreamForPath, finalMsg.toolCallId)
            : undefined;

          const toolFiles: AttachedFileMeta[] = [
            ...extractImagesAsAttachedFiles(finalMsg.content),
          ];
          if (matchedPath) {
            for (const file of toolFiles) {
              if (!file.filePath) {
                file.filePath = matchedPath;
                file.fileName = matchedPath.split(/[\\/]/).pop() || 'image';
              }
            }
          }
          const text = getMessageText(finalMsg.content);
          if (text) {
            const mediaRefs = extractMediaRefs(text);
            const mediaRefPaths = new Set(mediaRefs.map((ref) => ref.filePath));
            for (const ref of mediaRefs) toolFiles.push(makeAttachedFile(ref));
            for (const ref of extractRawFilePaths(text)) {
              if (!mediaRefPaths.has(ref.filePath)) toolFiles.push(makeAttachedFile(ref));
            }
          }
          set((s) => {
            const currentStream = s.streamingMessage as RawMessage | null;
            const snapshotMsgs: RawMessage[] = [];
            if (currentStream) {
              const streamRole = currentStream.role;
              if (streamRole === 'assistant' || streamRole === undefined) {
                const snapId = currentStream.id || `${runId || 'run'}-turn-${s.messages.length}`;
                if (!s.messages.some((message) => message.id === snapId)) {
                  snapshotMsgs.push({
                    ...(currentStream as RawMessage),
                    role: 'assistant',
                    id: snapId,
                  });
                }
              }
            }
            return {
              messages: snapshotMsgs.length > 0 ? [...s.messages, ...snapshotMsgs] : s.messages,
              streamingText: '',
              streamingMessage: null,
              pendingFinal: true,
              pendingToolImages: toolFiles.length > 0
                ? [...s.pendingToolImages, ...toolFiles]
                : s.pendingToolImages,
              streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
            };
          });
          break;
        }

        const toolOnly = isToolOnlyMessage(finalMsg);
        const hasOutput = hasNonToolAssistantContent(finalMsg);
        const msgId = finalMsg.id || (toolOnly ? `run-${runId}-tool-${Date.now()}` : `run-${runId}`);
        set((s) => {
          const nextTools = updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools;
          const streamingTools = hasOutput ? [] : nextTools;
          const pendingImgs = s.pendingToolImages;
          const msgWithImages: RawMessage = pendingImgs.length > 0
            ? {
                ...finalMsg,
                role: (finalMsg.role || 'assistant') as RawMessage['role'],
                id: msgId,
                _attachedFiles: [...(finalMsg._attachedFiles || []), ...pendingImgs],
              }
            : { ...finalMsg, role: (finalMsg.role || 'assistant') as RawMessage['role'], id: msgId };
          const clearPendingImages = { pendingToolImages: [] as AttachedFileMeta[] };

          const alreadyExists = s.messages.some((message) => message.id === msgId);
          if (alreadyExists) {
            return toolOnly ? {
              streamingText: '',
              streamingMessage: null,
              pendingFinal: true,
              streamingTools,
              ...clearPendingImages,
            } : {
              streamingText: '',
              streamingMessage: null,
              sending: hasOutput ? false : s.sending,
              activeRunId: hasOutput ? null : s.activeRunId,
              pendingFinal: hasOutput ? false : true,
              streamingTools,
              ...clearPendingImages,
            };
          }

          return toolOnly ? {
            messages: [...s.messages, msgWithImages],
            streamingText: '',
            streamingMessage: null,
            pendingFinal: true,
            streamingTools,
            ...clearPendingImages,
          } : {
            messages: [...s.messages, msgWithImages],
            streamingText: '',
            streamingMessage: null,
            sending: hasOutput ? false : s.sending,
            activeRunId: hasOutput ? null : s.activeRunId,
            pendingFinal: hasOutput ? false : true,
            streamingTools,
            ...clearPendingImages,
          };
        });

        if (hasOutput && !toolOnly) {
          clearHistoryPoll();
          void get().loadHistory(true);
        }
      } else {
        set({ streamingText: '', streamingMessage: null, pendingFinal: true });
        get().loadHistory();
      }
      break;
    }
    case 'error': {
      const errorMsg = String(event.errorMessage || 'An error occurred');
      const normalizedErrorMsg = normalizeRuntimeErrorMessage(errorMsg, hasRecentUserImageMessage(get().messages));
      const wasSending = get().sending;

      const currentStream = get().streamingMessage as RawMessage | null;
      if (currentStream && (currentStream.role === 'assistant' || currentStream.role === undefined)) {
        const snapId = (currentStream as RawMessage).id || `error-snap-${Date.now()}`;
        const alreadyExists = get().messages.some((message) => message.id === snapId);
        if (!alreadyExists) {
          set((s) => ({
            messages: [...s.messages, { ...currentStream, role: 'assistant' as const, id: snapId }],
          }));
        }
      }

      set({
        error: normalizedErrorMsg,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        pendingFinal: false,
        pendingToolImages: [],
      });

      if (wasSending) {
        clearErrorRecoveryTimer();
        const ERROR_RECOVERY_GRACE_MS = 15_000;
        setErrorRecoveryTimer(setTimeout(() => {
          setErrorRecoveryTimer(null);
          const state = get();
          if (state.sending && !state.streamingMessage) {
            clearHistoryPoll();
            set({
              sending: false,
              activeRunId: null,
              lastUserMessageAt: null,
            });
            state.loadHistory(true);
          }
        }, ERROR_RECOVERY_GRACE_MS));
      } else {
        clearHistoryPoll();
        set({ sending: false, activeRunId: null, lastUserMessageAt: null });
      }
      break;
    }
    case 'aborted': {
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      set({
        sending: false,
        activeRunId: null,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
      });
      break;
    }
    default: {
      const { sending } = get();
      if (sending && event.message && typeof event.message === 'object') {
        console.warn(`[handleChatEvent] Unknown event state "${resolvedState}", treating message as streaming delta. Event keys:`, Object.keys(event));
        const updates = collectToolUpdates(event.message, 'delta');
        set((s) => ({
          streamingMessage: event.message ?? s.streamingMessage,
          streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
        }));
      }
      break;
    }
  }
}
