import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listConfiguredChannelsMock,
  sanitizeOpenClawConfigMock,
  syncBrowserConfigToOpenClawMock,
  syncGatewayTokenToConfigMock,
  syncProxyConfigToOpenClawMock,
} = vi.hoisted(() => ({
  listConfiguredChannelsMock: vi.fn(),
  sanitizeOpenClawConfigMock: vi.fn(),
  syncBrowserConfigToOpenClawMock: vi.fn(),
  syncGatewayTokenToConfigMock: vi.fn(),
  syncProxyConfigToOpenClawMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

vi.mock('@electron/utils/channel-config', () => ({
  listConfiguredChannels: (...args: unknown[]) => listConfiguredChannelsMock(...args),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  sanitizeOpenClawConfig: (...args: unknown[]) => sanitizeOpenClawConfigMock(...args),
  syncBrowserConfigToOpenClaw: (...args: unknown[]) => syncBrowserConfigToOpenClawMock(...args),
  syncGatewayTokenToConfig: (...args: unknown[]) => syncGatewayTokenToConfigMock(...args),
}));

vi.mock('@electron/utils/openclaw-proxy', () => ({
  syncProxyConfigToOpenClaw: (...args: unknown[]) => syncProxyConfigToOpenClawMock(...args),
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => '/tmp/ktclaw-openclaw',
  getOpenClawDir: () => '/tmp/ktclaw-openclaw-runtime',
  getOpenClawEntryPath: () => '/tmp/ktclaw-openclaw-runtime/openclaw.mjs',
  getOpenClawResolvedDir: () => '/tmp/ktclaw-openclaw-runtime',
  isOpenClawPresent: () => true,
}));

describe('gateway config sync port wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listConfiguredChannelsMock.mockResolvedValue([]);
  });

  it('passes the configured launch port when syncing gateway auth config', async () => {
    const { syncGatewayConfigBeforeLaunch } = await import('@electron/gateway/config-sync');

    await syncGatewayConfigBeforeLaunch({
      gatewayToken: 'launch-token',
    } as never, 24567);

    expect(syncProxyConfigToOpenClawMock).toHaveBeenCalledTimes(1);
    expect(sanitizeOpenClawConfigMock).toHaveBeenCalledTimes(1);
    expect(syncGatewayTokenToConfigMock).toHaveBeenCalledWith('launch-token', 24567);
    expect(syncBrowserConfigToOpenClawMock).toHaveBeenCalledTimes(1);
  });
});
