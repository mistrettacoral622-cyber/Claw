export const CAMERA_REQUEST_EVENT_TYPE = 'camera.request';
export const CAMERA_REQUEST_ACCEPTED_UI_EVENT = 'ktclaw:camera-request-accepted';

export interface CameraRequestDetail {
  id: string;
  sessionKey: string;
  runId?: string;
  reason?: string;
  requestedAt: number;
  status: 'pending' | 'accepted' | 'declined';
}

export function isCameraRequestEvent(event: Record<string, unknown>): boolean {
  return event.type === CAMERA_REQUEST_EVENT_TYPE || event.state === 'camera_request';
}
