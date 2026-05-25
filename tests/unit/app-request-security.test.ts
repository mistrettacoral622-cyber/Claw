// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const fsAccessMock = vi.fn();
const fsReadFileMock = vi.fn();
const fsStatMock = vi.fn();

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    gatewayToken: 'super-secret-token',
    language: 'en',
    proxyEnabled: false,
    proxyServer: '',
    proxyHttpServer: '',
    proxyHttpsServer: '',
    proxyAllServer: '',
    proxyBypassRules: '',
    launchAtStartup: false,
    ...overrides,
  };
}

const {
  mockGetAllSettings,
  mockGetSetting,
  mockResetSettings,
  mockProviderService,
  mockCheckPermission,
  mockNativeImageCreateFromPath,
} = vi.hoisted(() => ({
  mockGetAllSettings: vi.fn(),
  mockGetSetting: vi.fn(),
  mockResetSettings: vi.fn(),
  mockCheckPermission: vi.fn(async () => 'allow'),
  mockNativeImageCreateFromPath: vi.fn(() => ({
    isEmpty: () => false,
    getSize: () => ({ width: 20, height: 20 }),
    resize: () => ({ toPNG: () => Buffer.from('resized') }),
  })),
  mockProviderService: {
    listLegacyProvidersWithKeyInfo: vi.fn(),
    getLegacyProvider: vi.fn(),
    getDefaultLegacyProvider: vi.fn(),
    hasLegacyProviderApiKey: vi.fn(),
    getLegacyProviderApiKey: vi.fn(),
    validateLegacyProviderApiKey: vi.fn(),
    saveLegacyProvider: vi.fn(),
    deleteLegacyProvider: vi.fn(),
    setLegacyProviderApiKey: vi.fn(),
    deleteLegacyProviderApiKey: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  session: {
    defaultSession: {
      setProxy: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
    },
  },
  BrowserWindow: class {},
  shell: {
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
    openPath: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
  },
  app: {
    getVersion: vi.fn(() => '1.0.0'),
    getName: vi.fn(() => 'KTClaw'),
    getPath: vi.fn(() => '/tmp'),
    quit: vi.fn(),
    relaunch: vi.fn(),
  },
  nativeImage: {
    createFromPath: mockNativeImageCreateFromPath,
  },
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    access: (...args: unknown[]) => fsAccessMock(...args),
    readFile: (...args: unknown[]) => fsReadFileMock(...args),
    stat: (...args: unknown[]) => fsStatMock(...args),
  };
});

vi.mock('@electron/utils/store', () => ({
  getAllSettings: mockGetAllSettings,
  getSetting: mockGetSetting,
  resetSettings: mockResetSettings,
  setSetting: vi.fn(),
}));

vi.mock('@electron/utils/permissions-enforcer', () => ({
  checkPermission: mockCheckPermission,
  appendAuditLog: vi.fn(),
}));

vi.mock('@electron/services/providers/provider-service', () => ({
  getProviderService: () => mockProviderService,
}));

vi.mock('@electron/main/updater', () => ({
  appUpdater: {
    getStatus: vi.fn(),
    getCurrentVersion: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setChannel: vi.fn(),
    setAutoDownload: vi.fn(),
    cancelAutoInstall: vi.fn(),
  },
}));

const gatewayManager = {
  getStatus: vi.fn(),
  isConnected: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  rpc: vi.fn(),
  on: vi.fn(),
};

const clawHubService = {
  search: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  listInstalled: vi.fn(),
  openSkillReadme: vi.fn(),
};

const mainWindow = {
  minimize: vi.fn(),
  maximize: vi.fn(),
  unmaximize: vi.fn(),
  isMaximized: vi.fn(() => false),
  close: vi.fn(),
  isDestroyed: vi.fn(() => false),
  webContents: { send: vi.fn() },
};

describe('app:request security', () => {
  beforeEach(async () => {
    handlers.clear();
    vi.clearAllMocks();
    gatewayManager.getStatus.mockReturnValue({ state: 'stopped', port: 18789 });
    mockCheckPermission.mockResolvedValue('allow');
    fsAccessMock.mockResolvedValue(undefined);
    fsReadFileMock.mockResolvedValue(Buffer.from('file'));
    fsStatMock.mockResolvedValue({ size: 123 });
    const { registerIpcHandlers } = await import('@electron/main/ipc-handlers');
    registerIpcHandlers(
      gatewayManager,
      clawHubService,
      mainWindow,
      'session-token',
    );
  }, 40000);

  it('sanitizes gatewayToken for unified settings:get', async () => {
    const handler = handlers.get('app:request');
    expect(handler).toBeDefined();
    mockGetSetting.mockResolvedValueOnce('super-secret-token');

    const response = await handler?.({}, {
      id: 'req-1',
      module: 'settings',
      action: 'get',
      payload: { key: 'gatewayToken' },
    });

    expect(response).toEqual({
      id: 'req-1',
      ok: true,
      data: '',
    });
  });

  it('sanitizes gatewayToken for unified settings:getAll', async () => {
    const handler = handlers.get('app:request');
    expect(handler).toBeDefined();
    mockGetAllSettings.mockResolvedValueOnce(makeSettings());

    const response = await handler?.({}, {
      id: 'req-2',
      module: 'settings',
      action: 'getAll',
    });

    expect(response).toEqual({
      id: 'req-2',
      ok: true,
      data: makeSettings({ gatewayToken: '' }),
    });
  });

  it('sanitizes gatewayToken for unified settings:reset', async () => {
    const handler = handlers.get('app:request');
    expect(handler).toBeDefined();
    mockGetAllSettings.mockResolvedValue(makeSettings());

    const response = await handler?.({}, {
      id: 'req-reset',
      module: 'settings',
      action: 'reset',
    });

    expect(mockResetSettings).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      id: 'req-reset',
      ok: true,
      data: {
        success: true,
        settings: {
          gatewayToken: '',
          language: 'en',
          proxyEnabled: false,
          proxyServer: '',
          proxyHttpServer: '',
          proxyHttpsServer: '',
          proxyAllServer: '',
          proxyBypassRules: '',
          launchAtStartup: false,
        },
      },
    });
  });

  it('sanitizes gatewayToken for legacy settings:reset', async () => {
    const handler = handlers.get('settings:reset');
    expect(handler).toBeDefined();
    mockGetAllSettings.mockResolvedValue(makeSettings());

    const response = await handler?.({});

    expect(mockResetSettings).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      success: true,
      settings: {
        gatewayToken: '',
        language: 'en',
        proxyEnabled: false,
        proxyServer: '',
        proxyHttpServer: '',
        proxyHttpsServer: '',
        proxyAllServer: '',
        proxyBypassRules: '',
        launchAtStartup: false,
      },
    });
  });

  it('blocks unified provider.getApiKey from returning raw secrets', async () => {
    const handler = handlers.get('app:request');
    expect(handler).toBeDefined();

    const response = await handler?.({}, {
      id: 'req-3',
      module: 'provider',
      action: 'getApiKey',
      payload: { providerId: 'openai' },
    });

    expect(mockProviderService.getLegacyProviderApiKey).not.toHaveBeenCalled();
    expect(response).toEqual({
      id: 'req-3',
      ok: false,
      error: {
        code: 'UNSUPPORTED',
        message: 'APP_REQUEST_UNSUPPORTED:provider.getApiKey',
      },
    });
  });

  it('rejects non-staged media paths for chat:sendWithMedia', async () => {
    const handler = handlers.get('chat:sendWithMedia');
    expect(handler).toBeDefined();
    const filePath = join(homedir(), 'not-staged.png');

    const response = await handler?.({}, {
      sessionKey: 'session-1',
      message: 'hello',
      idempotencyKey: 'idem-1',
      media: [
        {
          filePath,
          mimeType: 'image/png',
          fileName: 'not-staged.png',
        },
      ],
    });

    expect(gatewayManager.rpc).not.toHaveBeenCalled();
    expect(fsReadFileMock).not.toHaveBeenCalled();
    expect(response).toEqual({
      success: false,
      error: 'MEDIA_PATH_NOT_STAGED',
      filePath,
    });
  });

  it('keeps staged image paths out of the Gateway message text when inline image attachments are present', async () => {
    const handler = handlers.get('chat:sendWithMedia');
    expect(handler).toBeDefined();

    const filePath = join(homedir(), '.openclaw', 'media', 'outbound', 'current-upload.png');
    gatewayManager.rpc.mockResolvedValueOnce({ runId: 'run-image' });

    const response = await handler?.({}, {
      sessionKey: 'session-1',
      message: 'Process the attached file(s).',
      idempotencyKey: 'idem-image',
      media: [
        {
          filePath,
          mimeType: 'image/png',
          fileName: 'current-upload.png',
        },
      ],
    });

    expect(response).toEqual({
      success: true,
      result: { runId: 'run-image' },
    });
    expect(gatewayManager.rpc).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({
        sessionKey: 'session-1',
        attachments: [
          expect.objectContaining({
            mimeType: 'image/png',
            fileName: 'current-upload.png',
          }),
        ],
        message: expect.not.stringContaining(filePath),
      }),
      120000,
    );
  });

  it('retries staged image sends as text-only file references when the Gateway rejects image_url content', async () => {
    const handler = handlers.get('chat:sendWithMedia');
    expect(handler).toBeDefined();

    const filePath = join(homedir(), '.openclaw', 'media', 'outbound', 'current-upload.png');
    gatewayManager.rpc
      .mockRejectedValueOnce(new Error('400 Failed to deserialize the JSON body into the target type: messages[75]: unknown variant image_url, expected text'))
      .mockResolvedValueOnce({ runId: 'run-fallback' });

    const response = await handler?.({}, {
      sessionKey: 'session-1',
      message: 'Process the attached file(s).',
      idempotencyKey: 'idem-image',
      media: [
        {
          filePath,
          mimeType: 'image/png',
          fileName: 'current-upload.png',
        },
      ],
    });

    expect(response).toEqual({
      success: true,
      result: { runId: 'run-fallback' },
    });
    expect(gatewayManager.rpc).toHaveBeenCalledTimes(2);
    expect(gatewayManager.rpc).toHaveBeenNthCalledWith(
      1,
      'chat.send',
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            mimeType: 'image/png',
            fileName: 'current-upload.png',
          }),
        ],
        message: expect.not.stringContaining(filePath),
      }),
      120000,
    );
    const [, fallbackParams] = gatewayManager.rpc.mock.calls[1] as [string, { attachments?: unknown; idempotencyKey?: string; message?: string }];
    expect(fallbackParams.attachments).toBeUndefined();
    expect(fallbackParams.idempotencyKey).toBe('idem-image:text-only-media-fallback');
    expect(fallbackParams.message).toContain(`[media attached: ${filePath} (image/png) | ${filePath}]`);
  });

  it('allows thumbnail reads for local image paths through the file read permission gate', async () => {
    const handler = handlers.get('media:getThumbnails');
    expect(handler).toBeDefined();
    const filePath = join(homedir(), 'Pictures', 'private.png');

    const response = await handler?.({}, [
      {
        filePath,
        mimeType: 'image/png',
      },
    ]);

    expect(mockCheckPermission).toHaveBeenCalledWith('file:read', { path: filePath });
    expect(fsStatMock).toHaveBeenCalledWith(filePath);
    expect(mockNativeImageCreateFromPath).toHaveBeenCalledWith(filePath);
    expect(response).toEqual({
      [filePath]: {
        preview: 'data:image/png;base64,ZmlsZQ==',
        fileSize: 123,
      },
    });
  });

  it('falls back to a direct thumbnail data URL when nativeImage cannot decode the file', async () => {
    mockNativeImageCreateFromPath.mockReturnValueOnce({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: () => ({ toPNG: () => Buffer.from('') }),
    });
    const handler = handlers.get('media:getThumbnails');
    expect(handler).toBeDefined();
    const filePath = join(homedir(), 'Pictures', 'private.png');

    const response = await handler?.({}, [
      {
        filePath,
        mimeType: 'image/png',
      },
    ]);

    expect(response).toEqual({
      [filePath]: {
        preview: 'data:image/png;base64,ZmlsZQ==',
        fileSize: 123,
      },
    });
  });

  it('does not read an oversized original image when nativeImage cannot decode it', async () => {
    mockNativeImageCreateFromPath.mockReturnValueOnce({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: () => ({ toPNG: () => Buffer.from('') }),
    });
    fsStatMock.mockResolvedValueOnce({ size: 25 * 1024 * 1024 });
    const handler = handlers.get('media:getThumbnails');
    expect(handler).toBeDefined();
    const filePath = join(homedir(), 'Pictures', 'huge photo.png');

    const response = await handler?.({}, [
      {
        filePath,
        mimeType: 'image/png',
      },
    ]);

    expect(fsReadFileMock).not.toHaveBeenCalled();
    expect(response).toEqual({
      [filePath]: {
        preview: null,
        fileSize: 25 * 1024 * 1024,
      },
    });
  });

  it('blocks thumbnail reads when file read permission is denied', async () => {
    mockCheckPermission.mockResolvedValueOnce('block');
    const handler = handlers.get('media:getThumbnails');
    expect(handler).toBeDefined();
    const filePath = join(homedir(), 'Pictures', 'private.png');

    const response = await handler?.({}, [
      {
        filePath,
        mimeType: 'image/png',
      },
    ]);

    expect(fsStatMock).not.toHaveBeenCalled();
    expect(mockNativeImageCreateFromPath).not.toHaveBeenCalled();
    expect(response).toEqual({
      [filePath]: {
        preview: null,
        fileSize: 0,
      },
    });
  });
});
