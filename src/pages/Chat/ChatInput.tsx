/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { SendHorizontal, Square, X, Paperclip, FileText, Film, Music, FileArchive, File, Loader2, FolderOpen, Camera, Sparkles, Mic, MicOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  buildConversationExportFileName,
  buildConversationMarkdownExport,
  encodeUtf8ToBase64,
} from '@/lib/chat-session-export';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { buildAgentModelRef } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useSettingsStore } from '@/stores/settings';
import { useProviderStore } from '@/stores/providers';
import type { AgentSummary } from '@/types/agent';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  buildLeaderOnlyBlockedMessage,
  isLeaderOnlyAgent,
  resolveReportingLeader,
} from '@/lib/team-chat-access';
import { CAMERA_REQUEST_ACCEPTED_UI_EVENT, type CameraRequestDetail } from '../../../shared/camera-request';
import { getChatInputSlashMatches, isSlashCommandPrefixInput, parseChatInputSlashCommand } from './slash-commands';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { CameraCaptureModal } from './CameraCaptureModal';

const CHAT_REQUEST_FILE_UPLOAD_EVENT = 'chat:request-file-upload';
const CHAT_UPLOAD_PENDING_KEY = 'ktclaw:pending-upload';

// ── Types ────────────────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;        // disk path for gateway
  preview: string | null;    // data URL for images, null for others
  status: 'staging' | 'ready' | 'error';
  error?: string;
}

interface ChatInputProps {
  onSend: (text: string, attachments?: FileAttachment[], targetAgentId?: string | null, workingDir?: string | null) => void;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
  isEmpty?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

/**
 * Read a browser File object as base64 string (without the data URL prefix).
 */
function readFileAsBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (!dataUrl || !dataUrl.includes(',')) {
        reject(new Error(`Invalid data URL from FileReader for ${file.name}`));
        return;
      }
      const base64 = dataUrl.split(',')[1];
      if (!base64) {
        reject(new Error(`Empty base64 data for ${file.name}`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// ── Component ────────────────────────────────────────────────────

export function ChatInput({ onSend, onStop, disabled = false, sending = false, isEmpty = false }: ChatInputProps) {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const rawComposerDraft = useChatStore((s) => ('composerDraft' in s && typeof s.composerDraft === 'string' ? s.composerDraft : undefined));
  const rawSetComposerDraft = useChatStore((s) => ('setComposerDraft' in s && typeof s.setComposerDraft === 'function'
    ? s.setComposerDraft
    : undefined));
  const [localComposerDraft, setLocalComposerDraft] = useState(rawComposerDraft ?? '');
  const composerDraft = typeof rawComposerDraft === 'string' ? rawComposerDraft : localComposerDraft;
  const setComposerDraft = useCallback((value: string) => {
    if (rawSetComposerDraft) {
      rawSetComposerDraft(value);
    }
    setLocalComposerDraft(value);
  }, [rawSetComposerDraft]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [, setFolderPopoverOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  // Microphone speech-to-text state
  const micPrefixRef = useRef('');
  const micSuffixRef = useRef('');
  const isComposingRef = useRef(false);
  const agents = useAgentsStore((s) => s.agents);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const messages = useChatStore((s) => s.messages);
  const newSession = useChatStore((s) => s.newSession);
  const generateImage = useChatStore((s) => ('generateImage' in s && typeof s.generateImage === 'function' ? s.generateImage : undefined));
  const currentAgent = useMemo(
    () => agents.find((agent) => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId],
  );
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const currentAgentName = currentAgent?.name ?? 'KTClaw';
  const currentModelDisplay = currentAgent?.modelDisplay ?? defaultModel ?? 'Not configured';

  // Model selector
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const providerAccounts = useProviderStore((s) => s.accounts);
  const providerVendors = useProviderStore((s) => s.vendors);
  const refreshProviderSnapshot = useProviderStore((s) => s.refreshProviderSnapshot);
  const updateAgent = useAgentsStore((s) => s.updateAgent);
  const modelOptions = useMemo(() => {
    const vendorMap = new Map(providerVendors.map((v) => [v.id, v]));
    const options: Array<{ value: string; label: string }> = [];
    for (const account of providerAccounts) {
      if (!account.enabled) continue;
      const vendor = vendorMap.get(account.vendorId);
      const modelId = account.model || vendor?.defaultModelId;
      const value = buildAgentModelRef(account, vendor);
      if (!modelId || !value) continue;
      const label = `${vendor?.name || account.vendorId} / ${modelId}`;
      if (!options.some((o) => o.value === value)) {
        options.push({ value, label });
      }
    }
    return options;
  }, [providerAccounts, providerVendors]);

  useEffect(() => {
    if (providerAccounts.length > 0 && providerVendors.length > 0) {
      return;
    }
    void refreshProviderSnapshot();
  }, [providerAccounts.length, providerVendors.length, refreshProviderSnapshot]);

  const selectedTarget = useMemo(
    () => agents.find((agent) => agent.id === targetAgentId) ?? null,
    [agents, targetAgentId],
  );
  const showLeaderOnlyBlockedMessage = useCallback((agentId: string) => {
    const blockedAgent = agents.find((agent) => agent.id === agentId);
    if (!blockedAgent) {
      toast.error('No matching agent found.');
      return;
    }
    toast.error(buildLeaderOnlyBlockedMessage(blockedAgent, resolveReportingLeader(blockedAgent, agents)));
  }, [agents]);
  const slashMatches = useMemo(() => getChatInputSlashMatches(composerDraft), [composerDraft]);
  const showSlashMenu = useMemo(
    () => isSlashCommandPrefixInput(composerDraft) && slashMatches.length > 0,
    [composerDraft, slashMatches.length],
  );
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraRequestedByAgent, setCameraRequestedByAgent] = useState(false);
  const [cameraRequestReason, setCameraRequestReason] = useState<string | undefined>(undefined);
  const [imagePromptError, setImagePromptError] = useState<string | null>(null);

  // Speech recognition hook callbacks
  const handleSpeechInterim = useCallback((interim: string) => {
    const currentPrefix = micPrefixRef.current;
    const currentSuffix = micSuffixRef.current;
    setComposerDraft(currentPrefix + interim + currentSuffix);
  }, [setComposerDraft]);

  const handleSpeechResult = useCallback((transcript: string) => {
    const currentPrefix = micPrefixRef.current;
    const currentSuffix = micSuffixRef.current;
    const separator = currentPrefix && !currentPrefix.endsWith(' ') ? ' ' : '';
    const newValue = currentPrefix + separator + transcript + currentSuffix;
    setComposerDraft(newValue);
    // Restore focus and place cursor after inserted text
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        const newCursorPos = currentPrefix.length + separator.length + transcript.length;
        ta.focus();
        ta.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 50);
  }, [setComposerDraft]);

  const handleSpeechError = useCallback((error: string) => {
    const errorMessages: Record<string, string> = {
      'no-speech': '未检测到语音，请重试',
      'aborted': '语音识别已取消',
      'not-allowed': '未获得麦克风权限，请检查系统设置',
      'audio-capture': '无法访问麦克风设备',
      'audio-decode-not-supported': '当前环境无法解码录音音频',
      'service-not-allowed': '本地语音识别服务不可用',
      'bad-grammar': '语音识别语法错误',
      'language-not-supported': '当前语言不支持语音识别',
      'nomatch': '未识别到语音，请重试',
      'permission-denied': '未获得麦克风权限，请检查系统设置',
      'no-microphone': '未检测到麦克风设备',
      'not-supported': '当前环境不支持语音识别',
    };
    const message = errorMessages[error] || `语音识别失败: ${error}`;
    toast.error(message);
  }, []);
  const [isSpeechTranscribing, setIsSpeechTranscribing] = useState(false);

  const {
    isListening,
    isSupported: isSpeechSupported,
    isTranscribing,
    start: startListening,
    stop: stopListening,
  } = useSpeechRecognition({
    lang: 'zh-CN',
    onInterim: handleSpeechInterim,
    onResult: handleSpeechResult,
    onTranscribingChange: setIsSpeechTranscribing,
    onError: handleSpeechError,
  });
  const isSpeechBusy = isListening || isTranscribing || isSpeechTranscribing;

  // Mic toggle handler
  const handleMicToggle = useCallback(() => {
    if (isListening) {
      stopListening();
    } else if (isSpeechBusy) {
      return;
    } else {
      const textarea = textareaRef.current;
      if (textarea) {
        micPrefixRef.current = composerDraft.slice(0, textarea.selectionStart);
        micSuffixRef.current = composerDraft.slice(textarea.selectionStart);
      } else {
        micPrefixRef.current = composerDraft;
        micSuffixRef.current = '';
      }
      startListening();
    }
  }, [isListening, isSpeechBusy, stopListening, startListening, composerDraft]);

  const activeSlashCommand = showSlashMenu
    ? (slashMatches[Math.min(slashActiveIndex, slashMatches.length - 1)] ?? null)
    : null;

  useEffect(() => {
    if (typeof rawComposerDraft === 'string') {
      setLocalComposerDraft(rawComposerDraft);
    }
  }, [rawComposerDraft]);

  const applySlashCompletion = useCallback((commandName: string) => {
    setComposerDraft(`${commandName} `);
    setImagePromptError(null);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [setComposerDraft]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [composerDraft]);

  // Focus textarea on mount (avoids Windows focus loss after session delete + native dialog)
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  useEffect(() => {
    if (!targetAgentId) return;
    if (targetAgentId === currentAgentId) {
      setTargetAgentId(null);
      setPickerOpen(false);
      return;
    }
    if (!agents.some((agent) => agent.id === targetAgentId)) {
      setTargetAgentId(null);
      setPickerOpen(false);
    }
  }, [agents, currentAgentId, targetAgentId]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [pickerOpen]);

  // ── File staging via native dialog ─────────────────────────────

  const pickFiles = useCallback(async () => {
    try {
      const result = await invokeIpc('dialog:open', {
        properties: ['openFile', 'multiSelections'],
      }) as { canceled: boolean; filePaths?: string[] };
      if (result.canceled || !result.filePaths?.length) return;

      // Add placeholder entries immediately
      const tempIds: string[] = [];
      for (const filePath of result.filePaths) {
        const tempId = crypto.randomUUID();
        tempIds.push(tempId);
        // Handle both Unix (/) and Windows (\) path separators
        const fileName = filePath.split(/[\\/]/).pop() || 'file';
        setAttachments(prev => [...prev, {
          id: tempId,
          fileName,
          mimeType: '',
          fileSize: 0,
          stagedPath: '',
          preview: null,
          status: 'staging' as const,
        }]);
      }

      // Stage all files via IPC
      const staged = await hostApiFetch<Array<{
        id: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
        stagedPath: string;
        preview: string | null;
      }>>('/api/files/stage-paths', {
        method: 'POST',
        body: JSON.stringify({ filePaths: result.filePaths }),
      });
      // Update each placeholder with real data
      setAttachments(prev => {
        let updated = [...prev];
        for (let i = 0; i < tempIds.length; i++) {
          const tempId = tempIds[i];
          const data = staged[i];
          if (data) {
            updated = updated.map(a =>
              a.id === tempId
                ? { ...data, status: 'ready' as const }
                : a,
            );
          } else {
            updated = updated.map(a =>
              a.id === tempId
                ? { ...a, status: 'error' as const, error: 'Staging failed' }
                : a,
            );
          }
        }
        return updated;
      });
    } catch (err) {
      // Silently fail — attachments already marked as 'error' above
      // Mark any stuck 'staging' attachments as 'error' so the user can remove them
      // and the send button isn't permanently blocked
      setAttachments(prev => prev.map(a =>
        a.status === 'staging'
          ? { ...a, status: 'error' as const, error: String(err) }
          : a,
      ));
    }
  }, []);

  useEffect(() => {
    const consumePendingUpload = () => {
      try {
        const pendingUpload = sessionStorage.getItem(CHAT_UPLOAD_PENDING_KEY);
        if (pendingUpload === '1') {
          sessionStorage.removeItem(CHAT_UPLOAD_PENDING_KEY);
          void pickFiles();
        }
      } catch {
        // ignore storage read errors
      }
    };

    consumePendingUpload();

    const onRequestUpload = () => {
      void pickFiles();
    };
    window.addEventListener(CHAT_REQUEST_FILE_UPLOAD_EVENT, onRequestUpload);
    return () => {
      window.removeEventListener(CHAT_REQUEST_FILE_UPLOAD_EVENT, onRequestUpload);
    };
  }, [pickFiles]);

  useEffect(() => {
    const onCameraRequestAccepted = (event: Event) => {
      const detail = (event as CustomEvent<CameraRequestDetail>).detail;
      if (!detail || detail.sessionKey !== currentSessionKey) {
        return;
      }
      setCameraRequestedByAgent(true);
      setCameraRequestReason(detail.reason);
      setCameraOpen(true);
    };

    window.addEventListener(CAMERA_REQUEST_ACCEPTED_UI_EVENT, onCameraRequestAccepted);
    return () => {
      window.removeEventListener(CAMERA_REQUEST_ACCEPTED_UI_EVENT, onCameraRequestAccepted);
    };
  }, [currentSessionKey]);

  // ── Stage browser File objects (paste / drag-drop) ─────────────

  const stageBufferFiles = useCallback(async (files: globalThis.File[]) => {
    for (const file of files) {
      const tempId = crypto.randomUUID();
      setAttachments(prev => [...prev, {
        id: tempId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        stagedPath: '',
        preview: null,
        status: 'staging' as const,
      }]);

      try {
        const base64 = await readFileAsBase64(file);
        const staged = await hostApiFetch<{
          id: string;
          fileName: string;
          mimeType: string;
          fileSize: number;
          stagedPath: string;
          preview: string | null;
        }>('/api/files/stage-buffer', {
          method: 'POST',
          body: JSON.stringify({
            base64,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
          }),
        });
        setAttachments(prev => prev.map(a =>
          a.id === tempId ? { ...staged, status: 'ready' as const } : a,
        ));
      } catch (err) {
        // Silently fail — attachment already marked as 'error'
        setAttachments(prev => prev.map(a =>
          a.id === tempId
            ? { ...a, status: 'error' as const, error: String(err) }
            : a,
        ));
      }
    }
  }, []);

  const stageSingleBufferFile = useCallback(async (file: globalThis.File): Promise<FileAttachment> => {
    const base64 = await readFileAsBase64(file);
    const staged = await hostApiFetch<{
      id: string;
      fileName: string;
      mimeType: string;
      fileSize: number;
      stagedPath: string;
      preview: string | null;
    }>('/api/files/stage-buffer', {
      method: 'POST',
      body: JSON.stringify({
        base64,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
      }),
    });

    return {
      ...staged,
      status: 'ready',
    };
  }, []);

  // ── Attachment management ──────────────────────────────────────

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const handleAttachCapturedPhoto = useCallback(async (file: File) => {
    const staged = await stageSingleBufferFile(file);
    setAttachments((prev) => [...prev, staged]);
    setCameraOpen(false);
    setCameraRequestedByAgent(false);
    setCameraRequestReason(undefined);
  }, [stageSingleBufferFile]);

  const handleIdentifyCapturedPhoto = useCallback(async (file: File) => {
    const staged = await stageSingleBufferFile(file);
    setCameraOpen(false);
    setCameraRequestedByAgent(false);
    setCameraRequestReason(undefined);
    onSend(
      '请识别这张图片里的主要内容，并用中文告诉我你看到了什么。',
      [staged],
      targetAgentId,
      workingDirectory,
    );
    setTargetAgentId(null);
    setPickerOpen(false);
    setWorkingDirectory(null);
  }, [onSend, stageSingleBufferFile, targetAgentId, workingDirectory]);

  const handleImageHelperClick = useCallback(() => {
    const trimmed = composerDraft.trim();
    setImagePromptError(null);
    if (!trimmed) {
      setComposerDraft('/image ');
    } else if (!trimmed.startsWith('/')) {
      setComposerDraft(`/image ${trimmed}`);
    }
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const length = textareaRef.current?.value.length ?? 0;
      textareaRef.current?.setSelectionRange(length, length);
    });
  }, [composerDraft, setComposerDraft]);

  const allReady = attachments.length === 0 || attachments.every(a => a.status === 'ready');
  const canSend = (composerDraft.trim() || attachments.length > 0) && allReady && !disabled && !sending;
  const canStop = sending && !disabled && !!onStop;

  const executeLocalSlashCommand = useCallback((rawInput: string): boolean => {
    const parsed = parseChatInputSlashCommand(rawInput);
    if (!parsed) return false;

    switch (parsed.command.key) {
      case 'new': {
        newSession();
        setComposerDraft('');
        setAttachments([]);
        setTargetAgentId(null);
        setPickerOpen(false);
        setWorkingDirectory(null);
        setFolderPopoverOpen(false);
        setSlashActiveIndex(0);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        return true;
      }
      case 'stop': {
        if (canStop) {
          onStop?.();
        } else {
          toast.info('No active run to stop.');
        }
        setComposerDraft('');
        return true;
      }
      case 'agent': {
        const query = parsed.args.trim();
        if (!query) {
          setPickerOpen(true);
          setComposerDraft('');
          return true;
        }
        const normalizedQuery = query.toLowerCase();
        if (normalizedQuery === 'clear' || normalizedQuery === 'none' || normalizedQuery === 'off') {
          setTargetAgentId(null);
          setPickerOpen(false);
          setComposerDraft('');
          return true;
        }

        const exactMatch = agents.find((agent) => (
          agent.id.toLowerCase() === normalizedQuery || agent.name.toLowerCase() === normalizedQuery
        ));
        const fuzzyMatch = agents.find((agent) => (
          agent.id !== currentAgentId
          && (
            agent.id.toLowerCase().includes(normalizedQuery)
            || agent.name.toLowerCase().includes(normalizedQuery)
          )
        ));
        const match = exactMatch ?? fuzzyMatch;
        if (!match || match.id === currentAgentId) {
          toast.error(`No matching agent found for "${query}".`);
          return true;
        }
        if (isLeaderOnlyAgent(match)) {
          showLeaderOnlyBlockedMessage(match.id);
          setTargetAgentId(null);
          setPickerOpen(false);
          setComposerDraft('');
          return true;
        }

        setTargetAgentId(match.id);
        setPickerOpen(false);
        setComposerDraft('');
        return true;
      }
      case 'cwd': {
        const query = parsed.args.trim();
        if (!query) {
          setFolderPopoverOpen(true);
          setComposerDraft('');
          return true;
        }
        const normalizedQuery = query.toLowerCase();
        if (normalizedQuery === 'clear' || normalizedQuery === 'none' || normalizedQuery === 'off') {
          setWorkingDirectory(null);
          setComposerDraft('');
          return true;
        }
        setWorkingDirectory(query);
        setFolderPopoverOpen(false);
        setComposerDraft('');
        return true;
      }
      case 'help': {
        setComposerDraft('/');
        setSlashActiveIndex(0);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
        return true;
      }
      case 'memory': {
        navigate('/memory');
        setComposerDraft('');
        setSlashActiveIndex(0);
        return true;
      }
      case 'cron': {
        navigate('/cron');
        setComposerDraft('');
        setSlashActiveIndex(0);
        return true;
      }
      case 'settings': {
        navigate('/settings');
        setComposerDraft('');
        setSlashActiveIndex(0);
        return true;
      }
      case 'image': {
        const prompt = parsed.args.trim();
        if (!prompt) {
          setImagePromptError('请输入图片提示词，例如 /image 一只橘猫坐在键盘旁边');
          requestAnimationFrame(() => {
            textareaRef.current?.focus();
          });
          return true;
        }
        setImagePromptError(null);
        void generateImage?.(prompt);
        setComposerDraft('');
        setSlashActiveIndex(0);
        return true;
      }
      case 'clear': {
        newSession();
        setComposerDraft('');
        setAttachments([]);
        setTargetAgentId(null);
        setPickerOpen(false);
        setWorkingDirectory(null);
        setFolderPopoverOpen(false);
        setSlashActiveIndex(0);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        return true;
      }
      case 'export': {
        setComposerDraft('');
        setSlashActiveIndex(0);
        if (messages.length === 0) {
          toast.info('No conversation messages to export yet.');
          return true;
        }

        const markdown = buildConversationMarkdownExport(messages, currentSessionKey);
        const base64 = encodeUtf8ToBase64(markdown);
        const defaultFileName = buildConversationExportFileName(currentSessionKey);
        void hostApiFetch<{ success?: boolean; savedPath?: string; error?: string }>('/api/files/save-image', {
          method: 'POST',
          body: JSON.stringify({
            base64,
            mimeType: 'text/markdown',
            defaultFileName,
          }),
        })
          .then((result) => {
            if (result?.success) {
              toast.success(result.savedPath ? `Exported to ${result.savedPath}` : 'Conversation exported.');
              return;
            }
            if (result?.error) {
              toast.info(`Export canceled: ${result.error}`);
              return;
            }
            toast.info('Export canceled.');
          })
          .catch((error) => {
            toast.error(`Failed to export conversation: ${String(error)}`);
          });
        return true;
      }
      default:
        return false;
    }
  }, [agents, canStop, currentAgentId, currentSessionKey, generateImage, messages, navigate, newSession, onStop, setComposerDraft, showLeaderOnlyBlockedMessage]);

  const handleSend = useCallback(() => {
    if (executeLocalSlashCommand(composerDraft)) return;
    if (!canSend) return;
    const readyAttachments = attachments.filter(a => a.status === 'ready');
    // Capture values before clearing — clear composer draft immediately for snappy UX,
    // but keep attachments available for the async send
    const textToSend = composerDraft.trim();
    const attachmentsToSend = readyAttachments.length > 0 ? readyAttachments : undefined;
    setComposerDraft('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onSend(textToSend, attachmentsToSend, targetAgentId, workingDirectory);
    setTargetAgentId(null);
    setPickerOpen(false);
    setWorkingDirectory(null);
  }, [
    attachments,
    canSend,
    composerDraft,
    executeLocalSlashCommand,
    onSend,
    setComposerDraft,
    targetAgentId,
    workingDirectory,
  ]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    onStop?.();
  }, [canStop, onStop]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSlashMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setSlashActiveIndex((prev) => {
          if (slashMatches.length === 0) return 0;
          if (e.key === 'ArrowDown') {
            return (prev + 1) % slashMatches.length;
          }
          return (prev - 1 + slashMatches.length) % slashMatches.length;
        });
        return;
      }
      if (showSlashMenu && e.key === 'Tab' && activeSlashCommand) {
        e.preventDefault();
        applySlashCompletion(activeSlashCommand.name);
        return;
      }
      if (e.key === 'Backspace' && !composerDraft && targetAgentId) {
        setTargetAgentId(null);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
          return;
        }
        e.preventDefault();
        if (showSlashMenu && activeSlashCommand) {
          const normalizedInput = composerDraft.trim();
          if (normalizedInput === activeSlashCommand.name && !activeSlashCommand.argsHint) {
            handleSend();
            return;
          }
          applySlashCompletion(activeSlashCommand.name);
          return;
        }
        handleSend();
      }
    },
    [activeSlashCommand, applySlashCompletion, handleSend, composerDraft, showSlashMenu, slashMatches.length, targetAgentId],
  );

  // Handle paste (Ctrl/Cmd+V with files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles: globalThis.File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        stageBufferFiles(pastedFiles);
      }
    },
    [stageBufferFiles],
  );

  // Handle drag & drop
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) {
        stageBufferFiles(Array.from(e.dataTransfer.files));
      }
    },
    [stageBufferFiles],
  );

  return (
    <div
      data-testid="chat-input-frame"
      className={cn('chat-input-frame flex w-full justify-center px-3 pb-4 sm:px-8 sm:pb-8', isEmpty ? 'chat-input-layout-empty' : 'chat-input-layout-active')}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mx-auto w-full max-w-[860px]">
        {/* Attachment Previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-3 flex-wrap">
            {attachments.map((att) => (
              <AttachmentPreview
                key={att.id}
                attachment={att}
                onRemove={() => removeAttachment(att.id)}
              />
            ))}
          </div>
        )}

        {/* Input Row */}
        <div
          data-testid="chat-composer-shell"
          className={cn(
            'chat-composer-shell relative overflow-hidden rounded-[24px] border transition-all duration-200',
            'bg-[#f2f2f7] dark:bg-card/95',
            dragOver
              ? 'border-primary/60 ring-2 ring-primary/25'
              : 'border-transparent',
            'focus-within:border-[#d1d1d1] focus-within:bg-white focus-within:shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
          )}
        >
          {(selectedTarget || workingDirectory) && (
            <div className="flex flex-wrap items-center gap-2 px-2.5 pt-2 pb-1">
              {selectedTarget && (
                <button
                  type="button"
                  onClick={() => setTargetAgentId(null)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[13px] font-medium text-foreground transition-colors hover:bg-primary/15"
                  title={t('composer.clearTarget')}
                >
                  <span>{t('composer.targetChip', { agent: selectedTarget.name })}</span>
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
              {workingDirectory && (
                <button
                  type="button"
                  onClick={() => setWorkingDirectory(null)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[13px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15"
                  title={workingDirectory}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span className="max-w-[160px] truncate">
                    {workingDirectory.split(/[\\/]/).filter(Boolean).pop() ?? workingDirectory}
                  </span>
                  <X className="h-3 w-3 opacity-70" />
                </button>
              )}
            </div>
          )}

          {showSlashMenu && (
            <div
              data-testid="chat-slash-menu"
              className="mx-3 mt-2 mb-1 overflow-hidden rounded-2xl border border-black/[0.08] bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
            >
              {slashMatches.map((command, index) => (
                <button
                  key={command.key}
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-[12px] transition-colors',
                    index === slashActiveIndex ? 'bg-[#f2f2f7]' : 'hover:bg-[#f7f7fa]',
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => applySlashCompletion(command.name)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-semibold text-foreground">{command.name}</span>
                    {command.argsHint && (
                      <span className="text-[#8e8e93]">{command.argsHint}</span>
                    )}
                  </div>
                  <span className="truncate text-[#8e8e93]">{command.description}</span>
                </button>
              ))}
            </div>
          )}

          <div data-testid="chat-composer-toolbar" className="chat-composer-toolbar relative flex flex-wrap items-end gap-2.5 py-2.5 pl-[14px] pr-[12px] sm:flex-nowrap sm:pl-[18px] sm:pr-[14px]">
            {/* Attach Button */}
            <Button
              variant="ghost"
              size="icon"
              className="h-[30px] w-[30px] shrink-0 rounded-full bg-transparent text-[#3c3c43] transition-colors hover:bg-[#e5e5ea] hover:text-black"
              onClick={pickFiles}
              disabled={disabled || sending}
              title={t('composer.attachFiles')}
            >
              <Paperclip className="h-4 w-4" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="h-[30px] w-[30px] shrink-0 rounded-full bg-transparent text-[#3c3c43] transition-colors hover:bg-[#e5e5ea] hover:text-black"
              onClick={() => {
                setCameraRequestedByAgent(false);
                setCameraRequestReason(undefined);
                setCameraOpen(true);
              }}
              disabled={disabled || sending}
              title="拍照"
              aria-label="拍照"
            >
              <Camera className="h-4 w-4" />
            </Button>

            {/* Microphone Button — local offline ASR */}
            {isSpeechSupported ? (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-[30px] w-[30px] shrink-0 rounded-full bg-transparent transition-colors',
                  isSpeechBusy
                    ? 'text-red-500 animate-mic-pulse hover:bg-red-50'
                    : 'text-[#3c3c43] hover:bg-[#e5e5ea] hover:text-black',
                )}
                onClick={handleMicToggle}
                disabled={disabled || sending || isSpeechTranscribing || isTranscribing}
                title={isSpeechTranscribing || isTranscribing ? '正在识别' : (isListening ? '停止聆听' : '语音输入')}
                aria-label={isSpeechTranscribing || isTranscribing ? '正在识别' : (isListening ? '停止聆听' : '语音输入')}
              >
                {isSpeechBusy ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </Button>
            ) : null}

            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded-full border border-black/10 bg-white px-2.5 py-1 text-[12px] text-[#3c3c43] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:border-black/20 hover:bg-[#f9f9f9]"
              onClick={handleImageHelperClick}
              disabled={disabled || sending}
              title="生成图片"
              aria-label="生成图片"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">生成图片</span>
            </button>

            {/* Textarea */}
            <div className="flex-1 relative">
              <Textarea
                ref={textareaRef}
                value={composerDraft}
                onChange={(e) => {
                  setComposerDraft(e.target.value);
                  if (imagePromptError) {
                    setImagePromptError(null);
                  }
                }}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onPaste={handlePaste}
                placeholder={isSpeechTranscribing || isTranscribing ? '正在识别...' : (isListening ? '正在聆听...' : `给 ${currentAgentName ?? 'KTClaw'} 发消息...`)}
                aria-label={isSpeechTranscribing || isTranscribing ? '正在识别...' : (isListening ? '正在聆听...' : `给 ${currentAgentName ?? 'KTClaw'} 发消息`)}
                disabled={disabled}
                className="min-h-[22px] max-h-[200px] resize-none border-0 bg-transparent px-0 py-0 text-[14px] leading-[22px] text-black placeholder:text-[#8e8e93] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:text-white"
                rows={1}
              />
              {imagePromptError ? (
                <p className="mt-2 text-[12px] text-[#d11a2a]">{imagePromptError}</p>
              ) : null}
            </div>

            {/* Model Pill */}
            <div className="relative" ref={modelPickerRef}>
              <button
                type="button"
                data-testid="chat-composer-model-pill"
                className="flex shrink-0 items-center gap-1 rounded-full border border-black/10 bg-white px-2.5 py-1 text-[12px] text-[#3c3c43] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:border-black/20 hover:bg-[#f9f9f9]"
                onClick={() => setModelPickerOpen((v) => !v)}
              >
                <span className={cn('h-[6px] w-[6px] rounded-full', currentModelDisplay === 'Not configured' ? 'bg-[#f59e0b]' : 'bg-[#10b981]')} />
                <span className="max-w-[140px] truncate font-medium">{currentModelDisplay}</span>
                <span className="text-[#8e8e93]">▾</span>
              </button>

              {modelPickerOpen && createPortal(
                <ModelPickerDropdown
                  anchorRef={modelPickerRef}
                  modelOptions={modelOptions}
                  currentAgent={currentAgent}
                  onSelect={async (model) => {
                    try {
                      if (currentAgent) {
                        const effectiveSessionKey = currentSessionKey || currentAgent.mainSessionKey;
                        if (effectiveSessionKey) {
                          const result = await invokeIpc<{ success: boolean; error?: string }>(
                            'gateway:rpc',
                            'sessions.patch',
                            {
                              key: effectiveSessionKey,
                              model: model || null,
                            },
                          );
                          if (!result.success) {
                            throw new Error(result.error || 'Failed to switch session model.');
                          }
                        }
                        await updateAgent(currentAgent.id, { model });
                      }
                      setModelPickerOpen(false);
                    } catch (error) {
                      toast.error(`Failed to switch model: ${String(error)}`);
                    }
                  }}
                  onClose={() => setModelPickerOpen(false)}
                />,
                document.body,
              )}
            </div>

            {/* Send Button */}
            <Button
              onClick={sending ? handleStop : handleSend}
              disabled={sending ? !canStop : !canSend}
              size="icon"
              className={`h-[30px] w-[30px] shrink-0 rounded-full transition-opacity ${
                (sending || canSend)
                  ? 'bg-[#10b981] text-white hover:bg-[#059669]'
                  : 'text-muted-foreground/50 hover:bg-transparent bg-transparent'
              }`}
              variant="ghost"
              title={sending ? t('composer.stop') : t('composer.send')}
              aria-label={sending ? t('composer.stop') : t('composer.send')}
            >
              {sending ? (
                <Square className="h-4 w-4" fill="currentColor" />
              ) : (
                <SendHorizontal className="h-[16px] w-[16px]" strokeWidth={2} />
              )}
            </Button>
          </div>

        </div>

        <CameraCaptureModal
          open={cameraOpen}
          requestedByAgent={cameraRequestedByAgent}
          requestReason={cameraRequestReason}
          onClose={() => {
            setCameraOpen(false);
            setCameraRequestedByAgent(false);
            setCameraRequestReason(undefined);
          }}
          onFallbackToFileUpload={() => {
            void pickFiles();
          }}
          onAttachPhoto={handleAttachCapturedPhoto}
          onIdentifyPhoto={handleIdentifyCapturedPhoto}
        />

        <div
          data-testid="chat-composer-footer"
          className="chat-composer-footer mt-2 px-2 text-center text-[11px] text-[#8e8e93] sm:px-0"
        >
          <span>Agent 在本地安全运行 · 由 AI 模型生成内容</span>
        </div>
      </div>
    </div>
  );
}

// ── Attachment Preview ───────────────────────────────────────────

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: FileAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.mimeType.startsWith('image/') && attachment.preview;

  return (
    <div className="relative group rounded-lg overflow-hidden border border-border">
      {isImage ? (
        // Image thumbnail
        <div className="w-16 h-16">
          <img
            src={attachment.preview!}
            alt={attachment.fileName}
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        // Generic file card
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 max-w-[200px]">
          <FileIcon mimeType={attachment.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 overflow-hidden">
            <p className="text-xs font-medium truncate">{attachment.fileName}</p>
            <p className="text-[10px] text-muted-foreground">
              {attachment.fileSize > 0 ? formatFileSize(attachment.fileSize) : '...'}
            </p>
          </div>
        </div>
      )}

      {/* Staging overlay */}
      {attachment.status === 'staging' && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
          <Loader2 className="h-4 w-4 text-white animate-spin" />
        </div>
      )}

      {/* Error overlay */}
      {attachment.status === 'error' && (
        <div className="absolute inset-0 bg-destructive/20 flex items-center justify-center">
          <span className="text-[10px] text-destructive font-medium px-1">Error</span>
        </div>
      )}

      {/* Remove button */}
      <button
        onClick={onRemove}
        className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function AgentPickerItem({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition-colors',
        selected ? 'bg-primary/10 text-foreground' : 'hover:bg-black/5 dark:hover:bg-white/5'
      )}
    >
      <span className="text-[14px] font-medium text-foreground">{agent.name}</span>
      <span className="text-[11px] text-muted-foreground">
        {agent.modelDisplay}
      </span>
    </button>
  );
}

// ── Model Picker Dropdown (portal) ──────────────────────────────

function ModelPickerDropdown({
  anchorRef,
  modelOptions,
  currentAgent,
  onSelect,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  modelOptions: Array<{ value: string; label: string }>;
  currentAgent: AgentSummary | null;
  onSelect: (model: string) => Promise<void>;
  onClose: () => void;
}) {
  const [pos, setPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      top: rect.top - 8,
      right: window.innerWidth - rect.right,
    });
  }, [anchorRef]);

  return (
    <div className="fixed inset-0 z-[200]" onMouseDown={onClose}>
      <div
        className="fixed z-[201] w-[260px] max-h-[320px] overflow-y-auto rounded-xl border border-black/10 bg-white py-1 shadow-xl"
        style={{ top: pos.top, right: pos.right, transform: 'translateY(-100%)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[#8e8e93]">选择模型</div>
        {modelOptions.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-[#8e8e93]">
            暂无可用模型，请先在设置中配置 AI 服务商
          </div>
        ) : (
          <>
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f2f2f7]',
                (currentAgent?.inheritedModel || !currentAgent?.model) && 'text-ktclaw-ac font-medium',
              )}
              onClick={() => void onSelect('')}
            >
              <span className="truncate">继承默认模型</span>
              {(currentAgent?.inheritedModel || !currentAgent?.model) && <span className="ml-auto text-ktclaw-ac">✓</span>}
            </button>
            <div className="mx-3 border-t border-black/[0.06]" />
            {modelOptions.map((opt) => {
              const isActive = currentAgent?.model === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f2f2f7]',
                    isActive && 'text-ktclaw-ac font-medium',
                  )}
                  onClick={() => void onSelect(opt.value)}
                >
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  {isActive && <span className="shrink-0 text-ktclaw-ac">✓</span>}
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ── Agent Picker Dropdown (portal) ──────────────────────────────

export function AgentPickerDropdown({
  anchorRef,
  agents,
  targetAgentId,
  title,
  onSelect,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  agents: AgentSummary[];
  targetAgentId: string | null;
  title: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.top - 8, left: rect.left });
  }, [anchorRef]);

  return (
    <div className="fixed inset-0 z-[200]" onMouseDown={onClose}>
      <div
        className="fixed z-[201] w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl"
        style={{ top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 text-[11px] font-medium text-[#8e8e93]">
          {title}
        </div>
        <div className="max-h-64 overflow-y-auto">
          {agents.map((agent) => (
            <AgentPickerItem
              key={agent.id}
              agent={agent}
              selected={agent.id === targetAgentId}
              onSelect={() => onSelect(agent.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
