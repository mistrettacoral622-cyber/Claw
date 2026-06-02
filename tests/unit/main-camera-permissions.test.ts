import { describe, expect, it } from 'vitest';
import { shouldAllowMediaPermission } from '@electron/main/media-permissions';

describe('media permissions', () => {
  // Test 1: video-only (Phase 18 camera path preserved)
  it('allows video-only media permission for the main window', () => {
    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: ['video'],
    })).toBe(true);
  });

  // Test 1b: uppercase variant of video-only
  it('allows video-only with uppercase mediaTypes (case-insensitive)', () => {
    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: ['VIDEO'],
    })).toBe(true);
  });

  // Test 2: audio-only is not needed now that local ASR has been removed.
  it('rejects audio-only media permission for the main window', () => {
    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: ['audio'],
    })).toBe(false);
  });

  // Test 2b: uppercase variant of audio-only
  it('rejects audio-only with uppercase mediaTypes (case-insensitive)', () => {
    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: ['AUDIO'],
    })).toBe(false);
  });

  // Test 3: video+audio combined is rejected because the app only needs still camera capture.
  it('rejects video+audio combined media permission for the main window', () => {
    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: ['video', 'audio'],
    })).toBe(false);
  });

  // Test 4: empty or missing mediaTypes
  it('rejects when mediaTypes is empty', () => {
    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: true,
      mediaTypes: [],
    })).toBe(false);
  });

  it('rejects when mediaTypes is missing', () => {
    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: true,
    })).toBe(false);
  });

  // Test 5: non-main-window origin
  it('rejects non-main-window origin regardless of mediaTypes', () => {
    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: false,
      mediaTypes: ['video'],
    })).toBe(false);

    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: false,
      mediaTypes: ['audio'],
    })).toBe(false);

    expect(shouldAllowMediaPermission({
      permission: 'media',
      isMainWindowWebContents: false,
      mediaTypes: ['video', 'audio'],
    })).toBe(false);
  });

  // Test 6: non-'media' permission
  it('rejects non-media permission types', () => {
    expect(shouldAllowMediaPermission({
      permission: 'notifications',
      isMainWindowWebContents: true,
      mediaTypes: ['video'],
    })).toBe(false);

    expect(shouldAllowMediaPermission({
      permission: 'geolocation',
      isMainWindowWebContents: true,
      mediaTypes: ['audio'],
    })).toBe(false);

    expect(shouldAllowMediaPermission({
      permission: 'media',
      mediaTypes: ['video'],
      isMainWindowWebContents: true,
    })).toBe(true);
  });
});
