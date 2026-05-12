export interface MediaPermissionDecisionInput {
  permission: string;
  isMainWindowWebContents: boolean;
  requestingUrl?: string;
  mediaTypes?: string[];
}

export function shouldAllowMediaPermission(input: MediaPermissionDecisionInput): boolean {
  if (input.permission !== 'media') {
    return false;
  }

  if (!input.isMainWindowWebContents) {
    return false;
  }

  const mediaTypes = Array.isArray(input.mediaTypes)
    ? input.mediaTypes.map((value) => value.toLowerCase())
    : [];

  // Permit video-only (Phase 18 camera)
  if (mediaTypes.includes('video') && !mediaTypes.includes('audio')) {
    return true;
  }

  // Permit audio-only (Phase 20 ASR microphone)
  if (mediaTypes.includes('audio') && !mediaTypes.includes('video')) {
    return true;
  }

  // Permit audio+video combined (future use — currently no consumer)
  if (mediaTypes.includes('video') && mediaTypes.includes('audio')) {
    return true;
  }

  return false;
}
