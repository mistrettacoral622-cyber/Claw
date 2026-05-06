import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/ktclaw-test'),
    getAppPath: vi.fn(() => '/tmp/ktclaw-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
  },
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../electron/services/image-search/image-directories', () => ({
  getDefaultImageDirectories: vi.fn(() => []),
}));

vi.mock('../../electron/services/image-search/image-index-manager', () => ({
  getImageIndexManager: vi.fn(() => ({
    startIndexing: vi.fn(),
  })),
}));

import {
  IMAGE_SEARCH_AUTO_INDEX_DELAY_MS,
  scheduleImageSearchAutoIndex,
  shouldAutoStartImageIndexing,
} from '../../electron/services/image-search/auto-index';

describe('image search auto-index startup scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is disabled by default', () => {
    expect(shouldAutoStartImageIndexing({})).toBe(false);
    expect(shouldAutoStartImageIndexing({ KTCLAW_ENABLE_IMAGE_SEARCH_AUTO_INDEX: '' })).toBe(false);
  });

  it('requires an explicit enable flag', () => {
    expect(shouldAutoStartImageIndexing({ KTCLAW_ENABLE_IMAGE_SEARCH_AUTO_INDEX: '1' })).toBe(true);
    expect(shouldAutoStartImageIndexing({ KTCLAW_ENABLE_IMAGE_SEARCH_AUTO_INDEX: 'true' })).toBe(true);
  });

  it('lets the disable flag override the enable flag', () => {
    expect(shouldAutoStartImageIndexing({
      KTCLAW_ENABLE_IMAGE_SEARCH_AUTO_INDEX: '1',
      KTCLAW_DISABLE_IMAGE_SEARCH_AUTO_INDEX: '1',
    })).toBe(false);
  });

  it('does not schedule a timer when disabled', () => {
    const setTimer = vi.fn();
    const logInfo = vi.fn();

    const scheduled = scheduleImageSearchAutoIndex({
      env: {},
      setTimer,
      logInfo,
    });

    expect(scheduled).toBe(false);
    expect(setTimer).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('Image auto-indexing skipped'));
  });

  it('starts indexing default directories when enabled', () => {
    const scheduledHandlers: Array<() => void> = [];
    const setTimer = vi.fn((handler: () => void, _delayMs: number) => {
      scheduledHandlers.push(handler);
      return 1;
    });
    const startIndexing = vi.fn();
    const logInfo = vi.fn();

    const scheduled = scheduleImageSearchAutoIndex({
      env: { KTCLAW_ENABLE_IMAGE_SEARCH_AUTO_INDEX: '1' },
      getDirectories: () => ['C:\\Users\\test\\Pictures'],
      getManager: () => ({ startIndexing }),
      setTimer,
      logInfo,
    });

    expect(scheduled).toBe(true);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), IMAGE_SEARCH_AUTO_INDEX_DELAY_MS);

    scheduledHandlers[0]();

    expect(startIndexing).toHaveBeenCalledWith(['C:\\Users\\test\\Pictures']);
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('Auto-indexing started'));
  });
});
