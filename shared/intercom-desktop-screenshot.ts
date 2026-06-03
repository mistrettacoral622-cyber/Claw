export interface IntercomDesktopScreenshotRequest {
  requestId: string;
  taskId: string;
  artifactPath: string;
  acceptedPath?: string;
  resultPath: string;
  reason?: string;
  requestedAt: number;
}
