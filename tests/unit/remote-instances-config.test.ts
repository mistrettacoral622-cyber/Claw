// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storeData } = vi.hoisted(() => ({
  storeData: new Map<string, Record<string, unknown>>(),
}));

vi.mock('electron-store', () => {
  class MockStore {
    name: string;
    store: Record<string, unknown>;

    constructor(options: { name: string; defaults?: Record<string, unknown> }) {
      this.name = options.name;
      const existing = storeData.get(options.name);
      this.store = existing
        ? structuredClone(existing)
        : structuredClone(options.defaults ?? {});
      storeData.set(options.name, this.store);
    }

    get(key: string) {
      return this.store[key];
    }

    set(keyOrValue: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrValue === 'string') {
        this.store[keyOrValue] = value;
        storeData.set(this.name, this.store);
        return;
      }

      this.store = {
        ...this.store,
        ...keyOrValue,
      };
      storeData.set(this.name, this.store);
    }
  }

  return {
    default: MockStore,
  };
});

describe('remote instance config store', () => {
  beforeEach(async () => {
    vi.resetModules();
    storeData.clear();
  });

  it('creates, lists, updates, and deletes remote instances in the KTClaw-owned store', async () => {
    const {
      createRemoteInstance,
      deleteRemoteInstance,
      getKTClawRemoteInstanceStore,
      listRemoteInstances,
      updateRemoteInstance,
    } = await import('@electron/services/remote-instances/config');

    const created = await createRemoteInstance({
      displayName: 'Remote Weather',
      agentCardUrl: 'https://remote.example/.well-known/agent-card.json',
      auth: {
        mode: 'bearer',
        token: 'secret-token',
      },
      health: {
        status: 'ok',
        message: 'fresh',
      },
    });

    expect(created.id).toMatch(/^remote-/);
    expect(created.auth.mode).toBe('bearer');
    expect(created.auth.token).toBe('secret-token');

    const listed = await listRemoteInstances();
    expect(listed).toHaveLength(1);
    expect(listed[0].displayName).toBe('Remote Weather');

    const updated = await updateRemoteInstance(created.id, {
      displayName: 'Remote Search',
      auth: {
        mode: 'headers',
        headers: {
          Authorization: 'Bearer other-secret',
          'X-Team': 'alpha',
        },
      },
    });

    expect(updated?.displayName).toBe('Remote Search');
    expect(updated?.auth.mode).toBe('headers');
    expect(updated?.auth.headers.Authorization).toBe('Bearer other-secret');
    expect(updated?.auth.headers['X-Team']).toBe('alpha');

    const deleted = await deleteRemoteInstance(created.id);
    expect(deleted).toBe(true);
    expect(await listRemoteInstances()).toEqual([]);

    const store = await getKTClawRemoteInstanceStore();
    expect(store.get('schemaVersion')).toBe(1);
  });

  it('migrates legacy clawx remote instance store data into the ktclaw store', async () => {
    storeData.set('clawx-remote-instances', {
      schemaVersion: 1,
      remoteInstances: {
        legacy: {
          id: 'legacy',
          displayName: 'Legacy Remote',
          agentCardUrl: 'https://legacy.example/agent-card.json',
          auth: {
            mode: 'none',
            headers: {},
          },
          agentCard: null,
          health: {
            status: 'unknown',
          },
          createdAt: '2026-05-20T00:00:00.000Z',
          updatedAt: '2026-05-20T00:00:00.000Z',
        },
      },
    });

    const { listRemoteInstances } = await import('@electron/services/remote-instances/config');
    const listed = await listRemoteInstances();

    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('legacy');
    expect(listed[0].displayName).toBe('Legacy Remote');
  });
});
