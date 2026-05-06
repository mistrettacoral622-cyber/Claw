/**
 * Electron Main Process Entry
 * Manages window creation, system tray, and IPC handlers
 */
import { app, BrowserWindow, nativeImage, session, shell } from 'electron';
import { appInstanceScope } from './bootstrap-instance-scope';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { dirname, join } from 'path';
import { GatewayManager } from '../gateway/manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createTray, sendDesktopNotification } from './tray';
import { createMenu } from './menu';
import { applyWindowsStartupSwitches, clearDevChromiumCaches } from './startup-hardening';

import { appUpdater, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { warmupNetworkOptimization } from '../utils/uv-env';
import { initTelemetry } from '../utils/telemetry';

import { ClawHubService } from '../gateway/clawhub';
import { ensureKTClawContext, repairKTClawOnlyBootstrapFiles } from '../utils/openclaw-workspace';
import { autoInstallCliIfNeeded, generateCompletionCache, installCompletionToProfile } from '../utils/openclaw-cli';
import { isQuitting, setQuitting } from './app-state';
import { applyProxySettings } from './proxy';
import { syncLaunchAtStartupSettingFromStore } from './launch-at-startup';
import {
  clearPendingSecondInstanceFocus,
  consumeMainWindowReady,
  createMainWindowFocusState,
  requestSecondInstanceFocus,
} from './main-window-focus';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from './quit-lifecycle';
import { createSignalQuitHandler } from './signal-quit';
import { acquireProcessInstanceFileLock } from './process-instance-lock';
import { getSetting } from '../utils/store';
import { syncWatchedDirs, clearAllWatchers } from '../api/routes/memory-watcher';
import { ensureBuiltinSkillsInstalled, ensurePreinstalledSkillsInstalled } from '../utils/skill-config';
import { startHostApiServer } from '../api/server';
import { HostEventBus } from '../api/event-bus';
import { deviceOAuthManager } from '../utils/device-oauth';
import { browserOAuthManager } from '../utils/browser-oauth';
import { syncAllProviderAuthToRuntime } from '../services/providers/provider-runtime-sync';
import { McpRuntimeManager } from '../services/mcp/runtime-manager';
import { SessionRuntimeManager, type RuntimeSessionRecord } from '../services/session-runtime-manager';
import { shouldAllowCameraPermission } from './media-permissions';
import { scheduleImageSearchSemanticPrewarm } from '../services/image-search/prewarm';
import { getImageIndexManager } from '../services/image-search/image-index-manager';
import { getDefaultImageDirectories } from '../services/image-search/image-directories';
import { loadMcpConfig } from '../api/routes/mcp';
import { resolveWindowChromeOptions } from './window-chrome';

// Disable GPU hardware acceleration globally for maximum stability across
// all GPU configurations (no GPU, integrated, discrete).
//
// Rationale (following VS Code's philosophy):
// - Page/file loading is async data fetching — zero GPU dependency.
// - The original per-platform GPU branching was added to avoid CPU rendering
//   competing with sync I/O on Windows, but all file I/O is now async
//   (fs/promises), so that concern no longer applies.
// - Software rendering is deterministic across all hardware; GPU compositing
//   behaviour varies between vendors (Intel, AMD, NVIDIA, Apple Silicon) and
//   driver versions, making it the #1 source of rendering bugs in Electron.
//
// Users who want GPU acceleration can pass `--enable-gpu` on the CLI or
// set `"disable-hardware-acceleration": false` in the app config (future).
app.disableHardwareAcceleration();
applyWindowsStartupSwitches({ ...app, platform: process.platform });
clearDevChromiumCaches({
  isPackaged: app.isPackaged,
  platform: process.platform,
  userDataDir: app.getPath('userData'),
});

// On Linux, set CHROME_DESKTOP so Chromium can find the correct .desktop file.
// On Wayland this maps the running window to ktclaw.desktop (→ icon + app grouping);
// on X11 it supplements the StartupWMClass matching.
// Must be called before app.whenReady() / before any window is created.
if (process.platform === 'linux') {
  (app as Electron.App & { setDesktopName?: (name: string) => void }).setDesktopName?.('ktclaw.desktop');
}

// Prevent multiple instances of the app from running simultaneously.
// Without this, two instances each spawn their own gateway process on the
// same port, then each treats the other's gateway as "orphaned" and kills
// it — creating an infinite kill/restart loop on Windows.
// The losing process must exit immediately so it never reaches Gateway startup.
const gotElectronLock = appInstanceScope.useElectronSingleInstanceLock
  ? app.requestSingleInstanceLock()
  : true;
if (!gotElectronLock) {
  app.exit(0);
}
let releaseProcessInstanceFileLock: () => void = () => {};
let gotFileLock = true;
if (gotElectronLock) {
  try {
    const fileLock = acquireProcessInstanceFileLock({
      userDataDir: app.getPath('userData'),
      lockName: appInstanceScope.lockName,
      force: appInstanceScope.forceCleanProcessLock,
    });
    gotFileLock = fileLock.acquired;
    releaseProcessInstanceFileLock = fileLock.release;
    if (!fileLock.acquired) {
      const ownerDescriptor = fileLock.ownerPid
        ? `${fileLock.ownerFormat ?? 'legacy'} pid=${fileLock.ownerPid}`
        : fileLock.ownerFormat === 'unknown'
          ? 'unknown lock format/content'
          : 'unknown owner';
      logger.info(
        `Another instance already holds process lock (${fileLock.lockPath}, ${ownerDescriptor}); exiting duplicate process`,
      );
      app.exit(0);
    }
  } catch (error) {
    logger.warn('Failed to acquire process instance file lock; continuing with Electron single-instance lock only', error);
  }
}
const gotTheLock = gotElectronLock && gotFileLock;

// Global references
let mainWindow: BrowserWindow | null = null;
let gatewayManager!: GatewayManager;
let clawHubService!: ClawHubService;
let hostEventBus!: HostEventBus;
let mcpRuntimeManager!: McpRuntimeManager;
let sessionRuntimeManager!: SessionRuntimeManager;
let hostApiServer: Server | null = null;
const hostApiSessionToken = randomBytes(24).toString('hex');
const mainWindowFocusState = createMainWindowFocusState();
const quitLifecycleState = createQuitLifecycleState();
let mainWindowRecoveryTimer: NodeJS.Timeout | null = null;
let mainWindowRecoveryPending = false;
let mainWindowRecoveryCount = 0;
let lastMainWindowRecoveryAt = 0;
const MAIN_WINDOW_RECOVERY_WINDOW_MS = 30_000;
const MAIN_WINDOW_RECOVERY_MAX = 3;

// Runtime-mutable desktop behavior settings (read at startup, updated via IPC events)
let _minimizeToTray = true;
let _suppressInitialShow = false;
let _notificationsEnabled = true;

async function loadWhatsAppLoginManager(): Promise<{
  whatsAppLoginManager: {
    on: (event: 'qr' | 'success' | 'error', listener: (payload: unknown) => void) => void;
  };
} | null> {
  try {
    return await import('../utils/whatsapp-login');
  } catch (error) {
    logger.warn('WhatsApp login manager unavailable; skipping startup event bridge', error);
    return null;
  }
}

/**
 * Resolve the icons directory path (works in both dev and packaged mode)
 */
function getIconsDir(): string {
  if (app.isPackaged) {
    // Packaged: icons are in extraResources → process.resourcesPath/resources/icons
    return join(process.resourcesPath, 'resources', 'icons');
  }
  // Development: relative to dist-electron/main/
  return join(__dirname, '../../resources/icons');
}

/**
 * Get the app icon for the current platform
 */
function getAppIcon(): Electron.NativeImage | undefined {
  if (process.platform === 'darwin') return undefined; // macOS uses the app bundle icon

  const iconsDir = getIconsDir();
  const iconPath =
    process.platform === 'win32'
      ? join(iconsDir, 'icon.ico')
      : join(iconsDir, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

/**
 * Create the main application window
 */
function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const chrome = resolveWindowChromeOptions(process.platform, process.env);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    icon: getAppIcon(),
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true, // Enable <webview> for embedding OpenClaw Control UI
      // Additional Linux-specific rendering fixes
      ...(process.platform === 'linux' && {
        enableRemoteModule: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      }),
    },
    // On macOS: hiddenInset (traffic-light buttons inset into the title bar)
    // On Windows: hidden (custom title bar drawn by the renderer)
    // On Linux: default (native window frame — required for Kylin V11 / cx4 GPU
    //   compatibility; frame:false triggers a frameless compositing path that
    //   the Jingjia Micro cx4 driver cannot render, causing a white screen)
    titleBarStyle: chrome.titleBarStyle,
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    frame: chrome.frame,
    autoHideMenuBar: chrome.autoHideMenuBar,
  });

  if (process.platform === 'linux' && chrome.useCustomTitleBar) {
    win.setMenuBarVisibility(false);
  }

  // Handle external links
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Debug: Log rendering errors (especially for Linux)
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Render process gone:', details);
    if (mainWindow === win) {
      scheduleMainWindowRecovery('render-process-gone', details, win);
    }
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error('Failed to load:', errorCode, errorDescription, validatedURL);
    scheduleDevServerReload(win, errorCode);
  });

  win.on('unresponsive', () => {
    logger.warn('Main window became unresponsive');
  });

  win.on('responsive', () => {
    logger.info('Main window became responsive again');
  });

  return win;
}

function loadWindowContents(win: BrowserWindow): void {
  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
    return;
  }

  void win.loadFile(join(__dirname, '../../dist/index.html'));
  // Auto-open DevTools on Linux for debugging white screen issues
  if (process.platform === 'linux' && process.env.CLAWX_DEBUG !== '0') {
    win.webContents.openDevTools();
  }
}

function scheduleDevServerReload(win: BrowserWindow, errorCode: number): void {
  // In dev mode, Electron may start before the Vite dev server is ready.
  // Retry loading the URL after a short delay when connection is refused.
  if (errorCode !== -102 || !process.env.VITE_DEV_SERVER_URL || win.isDestroyed()) {
    return;
  }

  setTimeout(() => {
    if (!win.isDestroyed()) {
      void win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    }
  }, 1500);
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return;
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.show();
  win.focus();
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  clearPendingSecondInstanceFocus(mainWindowFocusState);
  focusWindow(mainWindow);
}

function scheduleMainWindowRecovery(reason: string, details?: unknown, windowToReplace?: BrowserWindow | null): void {
  if (isQuitting()) {
    return;
  }

  const now = Date.now();
  if (now - lastMainWindowRecoveryAt > MAIN_WINDOW_RECOVERY_WINDOW_MS) {
    mainWindowRecoveryCount = 0;
  }
  lastMainWindowRecoveryAt = now;

  if (mainWindowRecoveryPending) {
    logger.warn(`Main window recovery already pending (${reason})`, details);
    return;
  }

  if (mainWindowRecoveryCount >= MAIN_WINDOW_RECOVERY_MAX) {
    logger.error(
      `Main window recovery suppressed after ${MAIN_WINDOW_RECOVERY_MAX} attempts in ${MAIN_WINDOW_RECOVERY_WINDOW_MS}ms`,
      details,
    );
    return;
  }

  mainWindowRecoveryPending = true;
  mainWindowRecoveryCount += 1;
  logger.warn(`Scheduling main window recovery (${reason})`, details);

  try {
    if (windowToReplace && !windowToReplace.isDestroyed()) {
      windowToReplace.destroy();
    }
  } catch (error) {
    logger.warn('Failed to destroy crashed main window before recovery:', error);
  }

  mainWindowRecoveryTimer = setTimeout(() => {
    mainWindowRecoveryTimer = null;

    if (isQuitting()) {
      mainWindowRecoveryPending = false;
      return;
    }

    try {
      const recoveredWindow = createMainWindow();
      loadWindowContents(recoveredWindow);
      logger.warn(`Main window recovery succeeded (${reason})`);
    } catch (error) {
      logger.error(`Main window recovery failed (${reason})`, error);
    } finally {
      mainWindowRecoveryPending = false;
    }
  }, 250);
}

function createMainWindow(): BrowserWindow {
  const win = createWindow();

  win.once('ready-to-show', () => {
    if (mainWindow !== win) {
      return;
    }

    const action = consumeMainWindowReady(mainWindowFocusState);
    if (action === 'focus') {
      focusWindow(win);
      return;
    }

    if (_suppressInitialShow) {
      return;
    }

    win.show();
  });

  win.on('close', (event) => {
    if (isQuitting()) return;
    if (_minimizeToTray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    logger.info('Main window closed', { quitting: isQuitting(), recoveryPending: mainWindowRecoveryPending });
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  mainWindow = win;
  return win;
}

/**
 * Initialize the application
 */
async function initialize(): Promise<void> {
  // Initialize logger first
  logger.init();
  logger.info('=== KTClaw Application Starting ===');
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}`
  );

  // Warm up network optimization (non-blocking)
  void warmupNetworkOptimization();

  // Initialize Telemetry early
  await initTelemetry();

  // Apply persisted proxy settings before creating windows or network requests.
  await applyProxySettings();
  await syncLaunchAtStartupSettingFromStore();

  // Read desktop behavior settings before creating the window
  const startMinimized = await getSetting('startMinimized');
  const minimizeToTray = await getSetting('minimizeToTray');
  const brandSubtitle = await getSetting('brandSubtitle');
  const notificationsEnabled = await getSetting('notificationsEnabled');
  const isAutostart = process.argv.includes('--autostart');
  _minimizeToTray = minimizeToTray;
  _notificationsEnabled = notificationsEnabled;
  _suppressInitialShow = isAutostart && startMinimized;

  // Start watched-directory memory watchers
  const watchedDirs = await getSetting('watchedMemoryDirs');
  if (Array.isArray(watchedDirs) && watchedDirs.length > 0) {
    syncWatchedDirs(watchedDirs);
  }

  const configuredGatewayPort = await getSetting('gatewayPort');
  if (typeof configuredGatewayPort === 'number') {
    gatewayManager.setConfiguredPort(configuredGatewayPort);
  }

  // Set application menu
  createMenu();

  // Create the main window
  const window = createMainWindow();

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    shouldAllowCameraPermission({
      permission,
      isMainWindowWebContents: webContents === window.webContents,
      requestingUrl: requestingOrigin,
      mediaTypes: details.mediaTypes,
    })
  ));

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldAllowCameraPermission({
      permission,
      isMainWindowWebContents: webContents === window.webContents,
      requestingUrl: details.requestingUrl,
      mediaTypes: details.mediaTypes,
    }));
  });

  // Apply window title with brandSubtitle
  const windowTitle = brandSubtitle ? `KTClaw — ${brandSubtitle}` : 'KTClaw';
  window.setTitle(windowTitle);

  // Create system tray
  createTray(window);

  // Override security headers ONLY for the OpenClaw Gateway Control UI.
  // The URL filter ensures this callback only fires for gateway requests,
  // avoiding unnecessary overhead on every other HTTP response.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:*/*', 'http://localhost:*/*'] },
    (details, callback) => {
      const requestUrl = new URL(details.url);
      const currentPort = String(gatewayManager.getStatus().port);
      if (
        !((requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost')
          && requestUrl.port === currentPort)
      ) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      const headers = { ...details.responseHeaders };
      delete headers['X-Frame-Options'];
      delete headers['x-frame-options'];
      if (headers['Content-Security-Policy']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      if (headers['content-security-policy']) {
        headers['content-security-policy'] = headers['content-security-policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      callback({ responseHeaders: headers });
    },
  );

  // Register IPC handlers
  registerIpcHandlers(gatewayManager, clawHubService, window, hostApiSessionToken);

  hostApiServer = startHostApiServer({
    gatewayManager,
    clawHubService,
    mcpRuntimeManager,
    sessionRuntimeManager,
    eventBus: hostEventBus,
    mainWindow: window,
    hostApiSessionToken,
  });

  // Keep runtime state in sync with settings changes
  hostEventBus.on('settings:minimizeToTray-changed', ({ minimizeToTray }: { minimizeToTray: boolean }) => {
    _minimizeToTray = minimizeToTray;
  });
  hostEventBus.on('settings:notifications-changed', ({ notificationsEnabled }: { notificationsEnabled: boolean }) => {
    _notificationsEnabled = notificationsEnabled;
  });
  hostEventBus.on('task:completed', (payload: { taskId?: string; content?: string }) => {
    if (!_notificationsEnabled) return;
    sendDesktopNotification('Task completed', payload.content || payload.taskId || 'A task finished.');
  });
  hostEventBus.on('human-intervention-required', (payload: { taskId?: string; status?: string; content?: string }) => {
    if (!_notificationsEnabled) return;
    sendDesktopNotification(
      'Human intervention required',
      payload.content || `${payload.taskId ?? 'Task'} is ${payload.status ?? 'waiting for input'}.`,
    );
  });
  hostEventBus.on('sync:failed', (payload: { message?: string }) => {
    if (!_notificationsEnabled) return;
    sendDesktopNotification('Sync failed', payload.message || 'A sync operation failed.');
  });

  loadWindowContents(window);

  const enabledMcpServers = loadMcpConfig().servers.filter((server) => server.enabled);
  if (enabledMcpServers.length > 0) {
    void Promise.allSettled(enabledMcpServers.map(async (server) => {
      if (server.transport === 'stdio') {
        await mcpRuntimeManager.startServer(server);
        return;
      }
      await mcpRuntimeManager.connectServer(server);
    })).then((results) => {
      const rejected = results.filter((result) => result.status === 'rejected');
      if (rejected.length > 0) {
        logger.warn(`Failed to restore ${rejected.length} enabled MCP server(s) on startup`);
      }
    });
  }

  // Register update handlers
  registerUpdateHandlers(appUpdater, window);

  appUpdater.on('status-changed', (status) => {
    hostEventBus.emit('update:status', status);
  });

  appUpdater.on('auto-install-countdown', (payload) => {
    hostEventBus.emit('update:auto-install-countdown', payload);
  });

  // Note: Auto-check for updates is driven by the renderer (update store init)
  // so it respects the user's "Auto-check for updates" setting.

  // Repair any bootstrap files that only contain KTClaw markers (no OpenClaw
  // template content). This fixes a race condition where ensureKTClawContext()
  // previously created the file before the gateway could seed the full template.
  void repairKTClawOnlyBootstrapFiles().catch((error) => {
    logger.warn('Failed to repair bootstrap files:', error);
  });

  // Pre-deploy built-in skills (feishu-doc, feishu-drive, feishu-perm, feishu-wiki)
  // to ~/.openclaw/skills/ so they are immediately available without manual install.
  void ensureBuiltinSkillsInstalled().catch((error) => {
    logger.warn('Failed to install built-in skills:', error);
  });

  // Pre-deploy bundled third-party skills from resources/preinstalled-skills.
  // This installs full skill directories (not only SKILL.md) in an idempotent,
  // non-destructive way and never blocks startup.
  void ensurePreinstalledSkillsInstalled().catch((error) => {
    logger.warn('Failed to install preinstalled skills:', error);
  });

  // Optional semantic image model prewarm. This is disabled by default and only
  // runs when KTCLAW_ENABLE_IMAGE_SEARCH_PREWARM=1 is set.
  scheduleImageSearchSemanticPrewarm();

  // Auto-start image indexing (D-02: silent background, D-01: auto-detect Pictures)
  setTimeout(() => {
    try {
      const dirs = getDefaultImageDirectories();
      if (dirs.length > 0) {
        const manager = getImageIndexManager();
        manager.startIndexing(dirs);
        logger.info(`Auto-indexing started for ${dirs.length} directory(s): ${dirs.join(', ')}`);
      }
    } catch (err) {
      logger.warn('Auto-indexing startup failed:', err);
    }
  }, 10000); // 10s delay to let app settle

  // Bridge gateway and host-side events before any auto-start logic runs, so
  // renderer subscribers observe the full startup lifecycle.
  gatewayManager.on('status', (status: { state: string }) => {
    hostEventBus.emit('gateway:status', status);
    if (status.state === 'running') {
      void ensureKTClawContext().catch((error) => {
        logger.warn('Failed to re-merge KTClaw context after gateway reconnect:', error);
      });
    }
  });

  gatewayManager.on('error', (error) => {
    hostEventBus.emit('gateway:error', { message: error.message });
    hostEventBus.emit('sync:failed', { message: error.message });
  });

  gatewayManager.on('notification', (notification) => {
    hostEventBus.emit('gateway:notification', notification);
  });

  gatewayManager.on('chat:message', (data) => {
    hostEventBus.emit('gateway:chat-message', data);
  });

  gatewayManager.on('channel:status', (data) => {
    hostEventBus.emit('gateway:channel-status', data);
  });

  gatewayManager.on('exit', (code) => {
    hostEventBus.emit('gateway:exit', { code });
  });

  deviceOAuthManager.on('oauth:code', (payload) => {
    hostEventBus.emit('oauth:code', payload);
  });

  deviceOAuthManager.on('oauth:start', (payload) => {
    hostEventBus.emit('oauth:start', payload);
  });

  deviceOAuthManager.on('oauth:success', (payload) => {
    hostEventBus.emit('oauth:success', { ...payload, success: true });
  });

  deviceOAuthManager.on('oauth:error', (error) => {
    hostEventBus.emit('oauth:error', error);
  });

  browserOAuthManager.on('oauth:start', (payload) => {
    hostEventBus.emit('oauth:start', payload);
  });

  browserOAuthManager.on('oauth:code', (payload) => {
    hostEventBus.emit('oauth:code', payload);
  });

  browserOAuthManager.on('oauth:success', (payload) => {
    hostEventBus.emit('oauth:success', { ...payload, success: true });
  });

  browserOAuthManager.on('oauth:error', (error) => {
    hostEventBus.emit('oauth:error', error);
  });

  const whatsappModule = await loadWhatsAppLoginManager();
  if (whatsappModule) {
    whatsappModule.whatsAppLoginManager.on('qr', (data) => {
      hostEventBus.emit('channel:whatsapp-qr', data);
    });

    whatsappModule.whatsAppLoginManager.on('success', (data) => {
      hostEventBus.emit('channel:whatsapp-success', data);
    });

    whatsappModule.whatsAppLoginManager.on('error', (error) => {
      hostEventBus.emit('channel:whatsapp-error', error);
    });
  }

  // Start Gateway automatically (this seeds missing bootstrap files with full templates)
  const gatewayAutoStart = await getSetting('gatewayAutoStart');
  if (gatewayAutoStart) {
    try {
      await syncAllProviderAuthToRuntime();
      logger.debug('Auto-starting Gateway...');
      await gatewayManager.start();
      logger.info('Gateway auto-start succeeded');
    } catch (error) {
      logger.error('Gateway auto-start failed:', error);
      mainWindow?.webContents.send('gateway:error', String(error));
    }
  } else {
    logger.info('Gateway auto-start disabled in settings');
  }

  // Merge KTClaw context snippets into the workspace bootstrap files.
  // The gateway seeds workspace files asynchronously after its HTTP server
  // is ready, so ensureKTClawContext will retry until the target files appear.
  void ensureKTClawContext().catch((error) => {
    logger.warn('Failed to merge KTClaw context into workspace:', error);
  });

  // Auto-install openclaw CLI and shell completions (non-blocking).
  void autoInstallCliIfNeeded((installedPath) => {
    mainWindow?.webContents.send('openclaw:cli-installed', installedPath);
  }).then(() => {
    generateCompletionCache();
    installCompletionToProfile();
  }).catch((error) => {
    logger.warn('CLI auto-install failed:', error);
  });
}

if (gotTheLock) {
  const requestQuitOnSignal = createSignalQuitHandler({
    logInfo: (message) => logger.info(message),
    requestQuit: () => app.quit(),
  });

  process.on('exit', () => {
    releaseProcessInstanceFileLock();
  });

  process.on('warning', (warning) => {
    logger.warn(`Node warning: ${warning.name} ${warning.message}`, {
      code: (warning as Error & { code?: string }).code,
    });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection in Electron main process:', reason);
  });

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logger.error(`Uncaught exception in Electron main process (${origin})`, error);
  });

  process.once('SIGINT', () => requestQuitOnSignal('SIGINT'));
  process.once('SIGTERM', () => requestQuitOnSignal('SIGTERM'));

  app.on('will-quit', () => {
    releaseProcessInstanceFileLock();
  });

  if (process.platform === 'win32') {
    app.setAppUserModelId(appInstanceScope.windowsAppUserModelId);
  }

  gatewayManager = new GatewayManager();
  clawHubService = new ClawHubService();
  hostEventBus = new HostEventBus();
  mcpRuntimeManager = new McpRuntimeManager();
  const getRuntimeSessionsFilePath = (): string => join(app.getPath('userData'), 'runtime-sessions.json');
  sessionRuntimeManager = new SessionRuntimeManager(gatewayManager, {
    listMcpTools: () => {
      const configs = loadMcpConfig().servers;
      return mcpRuntimeManager
        .listServers(configs)
        .filter((server) => server.connected)
        .flatMap((server) => mcpRuntimeManager.listTools(server.name).map((tool) => ({
          server: tool.server,
          name: tool.name,
        })));
    },
  }, {
    load: async () => {
      const filePath = getRuntimeSessionsFilePath();
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          return parsed as RuntimeSessionRecord[];
        }
        if (typeof parsed === 'object' && parsed != null && Array.isArray((parsed as { sessions?: unknown }).sessions)) {
          return (parsed as { sessions: RuntimeSessionRecord[] }).sessions;
        }
        return [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('Failed to load persisted runtime sessions:', error);
        }
        return [];
      }
    },
    save: async (records) => {
      const filePath = getRuntimeSessionsFilePath();
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify({ version: 1, sessions: records }, null, 2), 'utf8');
      } catch (error) {
        logger.warn('Failed to persist runtime sessions:', error);
      }
    },
  });

  // When a second instance is launched, focus the existing window instead.
  app.on('second-instance', () => {
    logger.info('Second KTClaw instance detected; redirecting to the existing window');

    const focusRequest = requestSecondInstanceFocus(
      mainWindowFocusState,
      Boolean(mainWindow && !mainWindow.isDestroyed()),
    );

    if (focusRequest === 'focus-now') {
      focusMainWindow();
      return;
    }

    logger.debug('Main window is not ready yet; deferring second-instance focus until ready-to-show');
  });

  // Application lifecycle
  app.whenReady().then(() => {
    void initialize().catch((error) => {
      logger.error('Application initialization failed:', error);
    });

    // Register activate handler AFTER app is ready to prevent
    // "Cannot create BrowserWindow before app is ready" on macOS.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        loadWindowContents(createMainWindow());
      } else {
        focusMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    logger.warn('window-all-closed fired', {
      platform: process.platform,
      recoveryPending: mainWindowRecoveryPending,
      quitting: isQuitting(),
    });
    if (mainWindowRecoveryPending && !isQuitting()) {
      return;
    }
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('child-process-gone', (_event, details) => {
    logger.error('Electron child process gone:', details);
  });

  app.on('before-quit', (event) => {
    setQuitting();
    clearAllWatchers();
    logger.warn('before-quit fired');

    if (mainWindowRecoveryTimer) {
      clearTimeout(mainWindowRecoveryTimer);
      mainWindowRecoveryTimer = null;
    }
    mainWindowRecoveryPending = false;

    // Shutdown image index manager (closes DB and terminates worker)
    try {
      getImageIndexManager().shutdown();
    } catch { /* ignore shutdown errors during quit */ }

    const action = requestQuitLifecycleAction(quitLifecycleState);

    if (action === 'allow-quit') {
      return;
    }

    event.preventDefault();

    if (action === 'cleanup-in-progress') {
      logger.debug('Quit requested while cleanup already in progress; waiting for shutdown task to finish');
      return;
    }

    hostEventBus.closeAll();
    hostApiServer?.close();

    const shutdownPromise = Promise.allSettled([
      gatewayManager.stop().catch((err) => {
        logger.warn('gatewayManager.stop() error during quit:', err);
      }),
      mcpRuntimeManager.shutdown().catch((err) => {
        logger.warn('mcpRuntimeManager.shutdown() error during quit:', err);
      }),
    ]).then(() => 'stopped' as const);
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 5000);
    });

    void Promise.race([shutdownPromise, timeoutPromise]).then((result) => {
      if (result === 'timeout') {
        logger.warn('Gateway shutdown timed out during app quit; proceeding with forced quit');
        void gatewayManager.forceTerminateOwnedProcessForQuit().then((terminated) => {
          if (terminated) {
            logger.warn('Forced gateway process termination completed after quit timeout');
          }
        }).catch((err) => {
          logger.warn('Forced gateway termination failed after quit timeout:', err);
        });
      }

      markQuitCleanupCompleted(quitLifecycleState);
      app.quit();
    });
  });
}

// Export for testing
export { mainWindow, gatewayManager };
