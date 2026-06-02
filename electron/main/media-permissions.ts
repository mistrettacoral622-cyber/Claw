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

  return mediaTypes.includes('video') && !mediaTypes.includes('audio');
}
