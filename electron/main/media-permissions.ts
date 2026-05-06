export interface CameraPermissionDecisionInput {
  permission: string;
  isMainWindowWebContents: boolean;
  requestingUrl?: string;
  mediaTypes?: string[];
}

export function shouldAllowCameraPermission(input: CameraPermissionDecisionInput): boolean {
  if (input.permission !== 'media') {
    return false;
  }

  if (!input.isMainWindowWebContents) {
    return false;
  }

  const mediaTypes = Array.isArray(input.mediaTypes)
    ? input.mediaTypes.map((value) => value.toLowerCase())
    : [];

  if (!mediaTypes.includes('video')) {
    return false;
  }

  if (mediaTypes.includes('audio')) {
    return false;
  }

  return true;
}
