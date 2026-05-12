import { useState, useRef, useCallback, useEffect } from 'react';
import { invokeIpc } from '@/lib/api-client';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export interface UseSpeechRecognitionOptions {
  /** Language tag, default 'zh-CN' */
  lang?: string;
  /** Called with partial/interim transcript during speech */
  onInterim?: (transcript: string) => void;
  /** Called with final transcript when utterance completes or stop() is called */
  onResult?: (transcript: string) => void;
  /** Called when transcription is in progress after recording stops */
  onTranscribingChange?: (isTranscribing: boolean) => void;
  /** Called on recognition error, permission denial, or nomatch */
  onError?: (error: string) => void;
}

export interface UseSpeechRecognitionReturn {
  /** Whether microphone recording is currently active */
  isListening: boolean;
  /** Whether local recording and transcription are supported */
  isSupported: boolean;
  /** Whether local ASR is currently transcribing recorded audio */
  isTranscribing: boolean;
  /** Request mic permission and start listening */
  start: () => void;
  /** Stop listening and finalize */
  stop: () => void;
}

type LocalAsrResult = {
  text?: string;
};

const MAX_RECORDING_MS = 60_000;
const WAV_SAMPLE_RATE = 16_000;

function getMediaRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function encodeWavBase64(samples: Float32Array, sampleRate: number): string {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

async function blobTo16kMono(blob: Blob): Promise<Float32Array> {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('audio-decode-not-supported');
  }

  const inputContext = new AudioContextCtor();
  try {
    const audioBuffer = await inputContext.decodeAudioData(await blob.arrayBuffer());
    const offlineContext = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * WAV_SAMPLE_RATE), WAV_SAMPLE_RATE);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start(0);
    const rendered = await offlineContext.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  } finally {
    await inputContext.close().catch(() => undefined);
  }
}

export function useSpeechRecognition({
  lang = 'zh-CN',
  onInterim,
  onResult,
  onTranscribingChange,
  onError,
}: UseSpeechRecognitionOptions = {}): UseSpeechRecognitionReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef(0);
  const onInterimRef = useRef(onInterim);
  const onResultRef = useRef(onResult);
  const onTranscribingChangeRef = useRef(onTranscribingChange);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onInterimRef.current = onInterim;
    onResultRef.current = onResult;
    onTranscribingChangeRef.current = onTranscribingChange;
    onErrorRef.current = onError;
  }, [onInterim, onResult, onTranscribingChange, onError]);

  useEffect(() => {
    setIsSupported(
      typeof navigator !== 'undefined'
        && Boolean(navigator.mediaDevices?.getUserMedia)
        && typeof MediaRecorder !== 'undefined'
        && (typeof AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined'),
    );
  }, []);

  const stopTracks = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  const transcribeBlob = useCallback(async (blob: Blob, sessionId: number) => {
    if (blob.size === 0) {
      onErrorRef.current?.('no-speech');
      return;
    }

    setIsTranscribing(true);
    onTranscribingChangeRef.current?.(true);
    try {
      const samples = await blobTo16kMono(blob);
      if (sessionId !== sessionIdRef.current) return;
      const wavBase64 = encodeWavBase64(samples, WAV_SAMPLE_RATE);
      const result = await invokeIpc<LocalAsrResult>('speech:transcribeLocal', {
        wavBase64,
        language: lang,
      });
      if (sessionId !== sessionIdRef.current) return;
      const text = result.text?.trim() ?? '';
      if (!text) {
        onErrorRef.current?.('nomatch');
        return;
      }
      onResultRef.current?.(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onErrorRef.current?.(message || 'transcription-failed');
    } finally {
      if (sessionId === sessionIdRef.current) {
        setIsTranscribing(false);
        onTranscribingChangeRef.current?.(false);
      }
    }
  }, [lang]);

  const cleanupRecorder = useCallback(() => {
    clearStopTimer();
    recorderRef.current = null;
    chunksRef.current = [];
    stopTracks();
    setIsListening(false);
  }, [clearStopTimer, stopTracks]);

  const stop = useCallback(() => {
    clearStopTimer();
    const recorder = recorderRef.current;
    if (!recorder) {
      stopTracks();
      setIsListening(false);
      return;
    }
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, [clearStopTimer, stopTracks]);

  const start = useCallback(async () => {
    if (!isSupported) {
      onErrorRef.current?.('not-supported');
      return;
    }

    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      stop();
      return;
    }

    sessionIdRef.current += 1;
    const sessionId = sessionIdRef.current;
    chunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        onErrorRef.current?.('permission-denied');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        onErrorRef.current?.('no-microphone');
      } else {
        onErrorRef.current?.(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    try {
      const mimeType = getMediaRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        onErrorRef.current?.('audio-capture');
        cleanupRecorder();
      };

      recorder.onstop = () => {
        const chunks = chunksRef.current;
        const recordedMimeType = recorder.mimeType || mimeType || 'audio/webm';
        cleanupRecorder();
        const blob = new Blob(chunks, { type: recordedMimeType });
        void transcribeBlob(blob, sessionId);
      };

      recorder.start();
      setIsListening(true);
      onInterimRef.current?.('');
      stopTimerRef.current = setTimeout(() => {
        if (recorderRef.current === recorder && recorder.state !== 'inactive') {
          recorder.stop();
        }
      }, MAX_RECORDING_MS);
    } catch (error) {
      cleanupRecorder();
      onErrorRef.current?.(error instanceof Error ? error.message : String(error));
    }
  }, [cleanupRecorder, isSupported, stop, transcribeBlob]);

  useEffect(() => {
    return () => {
      sessionIdRef.current += 1;
      clearStopTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* ignore */ }
      }
      stopTracks();
    };
  }, [clearStopTimer, stopTracks]);

  return { isListening, isSupported, isTranscribing, start, stop };
}
