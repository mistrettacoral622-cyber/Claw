import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, CameraOff, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

type CameraModalMode =
  | 'request'
  | 'live'
  | 'captured'
  | 'permission_denied'
  | 'no_device'
  | 'error';

export interface CameraCaptureModalProps {
  open: boolean;
  requestedByAgent?: boolean;
  requestReason?: string;
  onClose: () => void;
  onFallbackToFileUpload?: () => void;
  onAttachPhoto: (file: File) => Promise<void>;
  onIdentifyPhoto: (file: File) => Promise<void>;
}

function blobToFile(blob: Blob, fileName: string): File {
  return new File([blob], fileName, { type: blob.type || 'image/jpeg' });
}

export function CameraCaptureModal({
  open,
  requestedByAgent = false,
  requestReason,
  onClose,
  onFallbackToFileUpload,
  onAttachPhoto,
  onIdentifyPhoto,
}: CameraCaptureModalProps) {
  const [mode, setMode] = useState<CameraModalMode>('request');
  const [busy, setBusy] = useState(false);
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const [capturedPreview, setCapturedPreview] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopStream = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const resetCapture = useCallback(() => {
    setCapturedPreview((prev) => {
      if (prev?.startsWith('blob:')) {
        URL.revokeObjectURL(prev);
      }
      return null;
    });
    setCapturedFile(null);
  }, []);

  const closeModal = useCallback(() => {
    stopStream();
    resetCapture();
    setBusy(false);
    setErrorMessage(null);
    setMode('request');
    onClose();
  }, [onClose, resetCapture, stopStream]);

  useEffect(() => {
    if (!open) {
      stopStream();
      resetCapture();
      setBusy(false);
      setErrorMessage(null);
      setMode('request');
      return;
    }
    setMode('request');
  }, [open, resetCapture, stopStream]);

  useEffect(() => () => {
    stopStream();
    if (capturedPreview?.startsWith('blob:')) {
      URL.revokeObjectURL(capturedPreview);
    }
  }, [capturedPreview, stopStream]);

  useEffect(() => {
    if (mode !== 'live' || !videoRef.current || !streamRef.current) {
      return;
    }

    const video = videoRef.current;
    video.srcObject = streamRef.current;
    void video.play().catch(() => {
      // Keep the modal open so the user can retry or fall back to upload.
      setMode('error');
      setErrorMessage('无法开始摄像头预览，请重试。');
    });
  }, [mode]);

  const openCamera = useCallback(async () => {
    setBusy(true);
    setErrorMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      setMode('live');
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError') {
        setMode('permission_denied');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setMode('no_device');
      } else {
        setMode('error');
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const capturePhoto = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) {
      return;
    }
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 960;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setMode('error');
      setErrorMessage('无法读取摄像头画面。');
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      setMode('error');
      setErrorMessage('拍照失败，请重试。');
      return;
    }
    resetCapture();
    const file = blobToFile(blob, `camera-capture-${Date.now()}.jpg`);
    setCapturedFile(file);
    setCapturedPreview(URL.createObjectURL(blob));
    stopStream();
    setMode('captured');
  }, [resetCapture, stopStream]);

  const submitCapturedFile = useCallback(async (modeToRun: 'attach' | 'identify') => {
    if (!capturedFile) {
      return;
    }
    setBusy(true);
    try {
      if (modeToRun === 'attach') {
        await onAttachPhoto(capturedFile);
      } else {
        await onIdentifyPhoto(capturedFile);
      }
      closeModal();
    } finally {
      setBusy(false);
    }
  }, [capturedFile, closeModal, onAttachPhoto, onIdentifyPhoto]);

  const title = useMemo(() => (
    requestedByAgent ? 'Agent 请求你拍一张照片' : '拍照'
  ), [requestedByAgent]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
      <div className="w-full max-w-[720px] rounded-[24px] border border-black/10 bg-card p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[18px] font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">仅使用摄像头，不会录音</p>
            {requestReason ? (
              <p className="mt-2 text-[12px] text-foreground/75">{requestReason}</p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-full"
            aria-label="关闭相机面板"
            onClick={closeModal}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-5">
          {mode === 'request' && (
            <div className="rounded-[24px] border border-black/10 bg-white/60 p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0a84ff]/10 text-[#0a84ff]">
                  <Camera className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[15px] font-medium text-foreground">打开摄像头前，你会先看到实时预览</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">不会录音，也不会自动发送，发送前你会再次确认。</p>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button type="button" className="rounded-full px-4" onClick={() => void openCamera()} disabled={busy}>
                  继续打开摄像头
                </Button>
                <Button type="button" variant="ghost" className="rounded-full border border-black/10 px-4" onClick={closeModal}>
                  暂不拍照
                </Button>
              </div>
            </div>
          )}

          {mode === 'live' && (
            <div>
              <div className="overflow-hidden rounded-[24px] border border-black/10 bg-black">
                <video ref={videoRef} className="aspect-[4/3] w-full object-cover" autoPlay muted playsInline />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" className="rounded-full px-4" onClick={() => void capturePhoto()} disabled={busy}>
                  拍照
                </Button>
                <Button type="button" variant="ghost" className="rounded-full border border-black/10 px-4" onClick={closeModal}>
                  停止预览
                </Button>
              </div>
            </div>
          )}

          {mode === 'captured' && (
            <div>
              <div className="overflow-hidden rounded-[24px] border border-black/10 bg-black">
                {capturedPreview ? (
                  <img src={capturedPreview} alt="camera capture" className="aspect-[4/3] w-full object-cover" />
                ) : null}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" className="rounded-full px-4" onClick={() => void submitCapturedFile('identify')} disabled={busy}>
                  拍照并识别
                </Button>
                <Button type="button" variant="ghost" className="rounded-full border border-black/10 px-4" onClick={() => void submitCapturedFile('attach')} disabled={busy}>
                  附加照片
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="rounded-full border border-black/10 px-4"
                  onClick={() => {
                    resetCapture();
                    void openCamera();
                  }}
                  disabled={busy}
                >
                  重新拍照
                </Button>
                <Button type="button" variant="ghost" className="rounded-full border border-black/10 px-4" onClick={closeModal}>
                  放弃这次拍照
                </Button>
              </div>
            </div>
          )}

          {(mode === 'permission_denied' || mode === 'no_device' || mode === 'error') && (
            <div className="rounded-[24px] border border-black/10 bg-white/60 p-6 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <CameraOff className="h-5 w-5" />
              </div>
              <p className="mt-4 text-[15px] font-medium text-foreground">
                {mode === 'permission_denied' ? '无法访问摄像头权限' : mode === 'no_device' ? '没有可用摄像头' : '打开摄像头失败'}
              </p>
              <p className="mt-2 text-[13px] text-muted-foreground">
                {mode === 'permission_denied'
                  ? '请检查系统权限后重试。'
                  : mode === 'no_device'
                    ? '你可以改用文件上传继续。'
                    : (errorMessage || '请稍后再试。')}
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {mode === 'permission_denied' || mode === 'error' ? (
                  <Button type="button" className="rounded-full px-4" onClick={() => void openCamera()} disabled={busy}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {mode === 'permission_denied' ? '重新打开摄像头权限' : '重试打开摄像头'}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  className="rounded-full border border-black/10 px-4"
                  onClick={() => {
                    closeModal();
                    onFallbackToFileUpload?.();
                  }}
                >
                  {mode === 'permission_denied' || mode === 'no_device' ? '改用文件上传' : '关闭相机面板'}
                </Button>
              </div>
            </div>
          )}
        </div>

        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>,
    document.body,
  );
}
