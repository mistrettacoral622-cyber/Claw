import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import { CameraCaptureModal } from '@/pages/Chat/CameraCaptureModal';
import {
  INTERCOM_DESKTOP_CAMERA_IPC_CHANNEL,
  type IntercomDesktopCameraRequest,
} from '../../../shared/intercom-desktop-camera';

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
      if (!base64) {
        reject(new Error(`Failed to read camera photo: ${file.name}`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read camera photo: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function IntercomDesktopCameraBridge() {
  const [request, setRequest] = useState<IntercomDesktopCameraRequest | null>(null);
  const completingRef = useRef(false);

  useEffect(() => subscribeHostEvent<IntercomDesktopCameraRequest>(
    INTERCOM_DESKTOP_CAMERA_IPC_CHANNEL,
    (payload) => {
      if (!payload?.requestId || !payload.artifactPath || !payload.resultPath) {
        return;
      }
      completingRef.current = false;
      setRequest(payload);
    },
  ), []);

  const completeRequest = useCallback(async (file: File) => {
    if (!request) {
      return;
    }
    completingRef.current = true;
    const base64 = await readFileAsBase64(file);
    await hostApiFetch('/api/intercom/desktop-camera/complete', {
      method: 'POST',
      body: JSON.stringify({
        requestId: request.requestId,
        taskId: request.taskId,
        artifactPath: request.artifactPath,
        resultPath: request.resultPath,
        base64,
        fileName: file.name || 'camera.jpg',
        mimeType: file.type || 'image/jpeg',
      }),
    });
    toast.success('远程拍照结果已返回');
    setRequest(null);
    completingRef.current = false;
  }, [request]);

  const failRequest = useCallback(async (error: string) => {
    if (!request || completingRef.current) {
      return;
    }
    completingRef.current = true;
    await hostApiFetch('/api/intercom/desktop-camera/fail', {
      method: 'POST',
      body: JSON.stringify({
        requestId: request.requestId,
        taskId: request.taskId,
        artifactPath: request.artifactPath,
        resultPath: request.resultPath,
        error,
      }),
    }).catch(() => undefined);
    setRequest(null);
    completingRef.current = false;
  }, [request]);

  return (
    <CameraCaptureModal
      open={Boolean(request)}
      requestedByAgent
      titleOverride="远程实例请求拍照"
      requestReason={request?.reason || '请用这台机器的摄像头拍照，并把照片作为远程任务结果返回。'}
      primaryActionLabel="拍照并返回"
      showSecondaryAction={false}
      onClose={() => void failRequest('Desktop camera request was cancelled.')}
      onAttachPhoto={completeRequest}
      onIdentifyPhoto={completeRequest}
    />
  );
}
