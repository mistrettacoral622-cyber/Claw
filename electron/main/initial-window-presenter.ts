export type InitialWindowAction = 'show' | 'focus';

export interface InitialWindowLike {
  isDestroyed(): boolean;
  isVisible?(): boolean;
  show(): void;
  focus(): void;
}

export interface InitialWindowPresenterOptions {
  getAction: () => InitialWindowAction;
  shouldSuppressInitialShow: () => boolean;
  showFallbackMs?: number;
  loadFallbackMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}

export interface InitialWindowPresenter {
  onReadyToShow: () => void;
  onDidFinishLoad: () => void;
  dispose: () => void;
}

const DEFAULT_SHOW_FALLBACK_MS = 5_000;
const DEFAULT_LOAD_FALLBACK_MS = 500;

export function createInitialWindowPresenter(
  win: InitialWindowLike,
  options: InitialWindowPresenterOptions,
): InitialWindowPresenter {
  const setTimeoutImpl = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutFn ?? clearTimeout;
  let handled = false;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = setTimeoutImpl(() => {
    present('fallback-timeout');
  }, options.showFallbackMs ?? DEFAULT_SHOW_FALLBACK_MS);

  function clearTimers(): void {
    if (loadTimer) {
      clearTimeoutImpl(loadTimer);
      loadTimer = null;
    }
    if (fallbackTimer) {
      clearTimeoutImpl(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function present(reason: string): void {
    if (handled || win.isDestroyed()) {
      return;
    }

    const action = options.getAction();
    if (action === 'focus') {
      handled = true;
      clearTimers();
      win.show();
      win.focus();
      options.logInfo?.(`Main window focused (${reason})`);
      return;
    }

    if (options.shouldSuppressInitialShow()) {
      handled = true;
      clearTimers();
      options.logInfo?.(`Initial main window show suppressed (${reason})`);
      return;
    }

    handled = true;
    clearTimers();
    if (reason === 'fallback-timeout') {
      options.logWarn?.('Main window ready-to-show did not fire; showing fallback window');
    } else if (reason === 'did-finish-load') {
      options.logInfo?.('Main window loaded before ready-to-show; showing fallback window');
    }
    win.show();
    win.focus();
  }

  return {
    onReadyToShow: () => present('ready-to-show'),
    onDidFinishLoad: () => {
      if (handled || loadTimer || win.isDestroyed()) {
        return;
      }
      loadTimer = setTimeoutImpl(() => {
        loadTimer = null;
        present('did-finish-load');
      }, options.loadFallbackMs ?? DEFAULT_LOAD_FALLBACK_MS);
    },
    dispose: () => {
      handled = true;
      clearTimers();
    },
  };
}
