import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn().mockResolvedValue({}),
}));

const KTCLAW_SETTINGS_KEY = 'ktclaw-settings';
const LEGACY_SETTINGS_KEY = 'clawx-settings';

describe('settings store persistence compatibility', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('hydrates from legacy renderer storage and migrates to KTClaw key', async () => {
    localStorage.setItem(
      LEGACY_SETTINGS_KEY,
      JSON.stringify({
        state: {
          sidebarCollapsed: true,
          language: 'en',
        },
        version: 0,
      }),
    );

    const { useSettingsStore } = await import('@/stores/settings');

    expect(useSettingsStore.getState().sidebarCollapsed).toBe(true);
    expect(localStorage.getItem(KTCLAW_SETTINGS_KEY)).toBeTruthy();
    expect(localStorage.getItem(LEGACY_SETTINGS_KEY)).toBeNull();
  });

  it('migrates old hardcoded default model to empty', async () => {
    localStorage.setItem(
      KTCLAW_SETTINGS_KEY,
      JSON.stringify({
        state: {
          defaultModel: 'claude-sonnet-4-6',
        },
        version: 0,
      }),
    );

    const { useSettingsStore } = await import('@/stores/settings');

    expect(useSettingsStore.getState().defaultModel).toBe('');
  });

  it('persists setup completion to the host settings api', async () => {
    const { hostApiFetch } = await import('@/lib/host-api');
    const { useSettingsStore } = await import('@/stores/settings');

    useSettingsStore.getState().markSetupComplete();

    expect(useSettingsStore.getState().setupComplete).toBe(true);
    await Promise.resolve();

    expect(vi.mocked(hostApiFetch)).toHaveBeenCalledWith(
      '/api/settings/setupComplete',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ value: true }),
      }),
    );
  });
});
