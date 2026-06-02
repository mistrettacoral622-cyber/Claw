export const INTERCOM_DESKTOP_CAMERA_IPC_CHANNEL = 'intercom:desktop-camera-request';

export interface IntercomDesktopCameraRequest {
  requestId: string;
  taskId: string;
  artifactPath: string;
  acceptedPath?: string;
  resultPath: string;
  reason?: string;
  requestedAt: number;
}

export interface IntercomDesktopCameraCompleteInput {
  requestId: string;
  taskId: string;
  artifactPath: string;
  resultPath: string;
  base64: string;
  fileName?: string;
  mimeType?: string;
}

export interface IntercomDesktopCameraFailInput {
  requestId: string;
  taskId: string;
  artifactPath: string;
  resultPath: string;
  error: string;
}
