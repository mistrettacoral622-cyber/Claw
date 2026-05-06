// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialWindowPresenter } from '@electron/main/initial-window-presenter';

function createWindow() {
  return {
    destroyed: false,
    show: vi.fn(),
    focus: vi.fn(),
    isDestroyed() {
      return this.destroyed;
    },
  };
}

describe('initial main window presenter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the window on ready-to-show', () => {
    const win = createWindow();
    const presenter = createInitialWindowPresenter(win, {
      getAction: () => 'show',
      shouldSuppressInitialShow: () => false,
    });

    presenter.onReadyToShow();

    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it('shows after did-finish-load when ready-to-show does not fire', () => {
    const win = createWindow();
    const presenter = createInitialWindowPresenter(win, {
      getAction: () => 'show',
      shouldSuppressInitialShow: () => false,
      loadFallbackMs: 250,
    });

    presenter.onDidFinishLoad();
    expect(win.show).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);

    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it('forces a visible window when neither ready nor load fires', () => {
    const win = createWindow();
    const logWarn = vi.fn();
    createInitialWindowPresenter(win, {
      getAction: () => 'show',
      shouldSuppressInitialShow: () => false,
      showFallbackMs: 1_000,
      logWarn,
    });

    vi.advanceTimersByTime(1_000);

    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith('Main window ready-to-show did not fire; showing fallback window');
  });

  it('keeps autostart-minimized windows hidden', () => {
    const win = createWindow();
    const presenter = createInitialWindowPresenter(win, {
      getAction: () => 'show',
      shouldSuppressInitialShow: () => true,
    });

    presenter.onReadyToShow();
    vi.runOnlyPendingTimers();

    expect(win.show).not.toHaveBeenCalled();
  });

  it('focuses when a second instance requested focus before readiness', () => {
    const win = createWindow();
    const presenter = createInitialWindowPresenter(win, {
      getAction: () => 'focus',
      shouldSuppressInitialShow: () => true,
    });

    presenter.onReadyToShow();

    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });
});
