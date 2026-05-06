import { describe, expect, it } from 'vitest';
import { shouldAllowCameraPermission } from '@electron/main/media-permissions';

describe('camera media permissions', () => {
  it('allows media permission only for the main KTClaw window', () => {
    expect(shouldAllowCameraPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: ['video'],
    })).toBe(true);

    expect(shouldAllowCameraPermission({
      permission: 'media',
      isMainWindowWebContents: false,
      mediaTypes: ['video'],
    })).toBe(false);
  });

  it('allows video-only camera requests', () => {
    expect(shouldAllowCameraPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: ['video'],
    })).toBe(true);
  });

  it('rejects media permission requests that include audio', () => {
    expect(shouldAllowCameraPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: ['video', 'audio'],
    })).toBe(false);
  });

  it('rejects requests without video mediaTypes', () => {
    expect(shouldAllowCameraPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: [],
    })).toBe(false);

    expect(shouldAllowCameraPermission({
      permission: 'notifications',
      isMainWindowWebContents: true,
      mediaTypes: ['video'],
    })).toBe(false);
  });
});
