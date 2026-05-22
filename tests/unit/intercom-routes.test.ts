import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const getIntercomSnapshotMock = vi.fn();
const upsertIntercomRouteMock = vi.fn();
const deleteIntercomRouteMock = vi.fn();
const sendIntercomMessageMock = vi.fn();
const installIntercomProtocolMock = vi.fn();

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/services/intercom', () => ({
  getIntercomSnapshot: (...args: unknown[]) => getIntercomSnapshotMock(...args),
  upsertIntercomRoute: (...args: unknown[]) => upsertIntercomRouteMock(...args),
  deleteIntercomRoute: (...args: unknown[]) => deleteIntercomRouteMock(...args),
  sendIntercomMessage: (...args: unknown[]) => sendIntercomMessageMock(...args),
  installIntercomProtocol: (...args: unknown[]) => installIntercomProtocolMock(...args),
}));

describe('intercom routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getIntercomSnapshotMock.mockResolvedValue({ routes: [] });
  });

  it('returns the intercom snapshot', async () => {
    getIntercomSnapshotMock.mockResolvedValue({ routes: [{ id: 'dev' }] });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      routes: [{ id: 'dev' }],
    });
  });

  it('upserts an intercom route', async () => {
    parseJsonBodyMock.mockResolvedValue({ id: 'ops', host: 'srv-c', agent: 'ops', transport: 'ssh' });
    upsertIntercomRouteMock.mockResolvedValue({ routes: [{ id: 'ops' }] });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/routes'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(upsertIntercomRouteMock).toHaveBeenCalledWith({
      id: 'ops',
      host: 'srv-c',
      agent: 'ops',
      transport: 'ssh',
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      routes: [{ id: 'ops' }],
    });
  });

  it('queues an intercom message', async () => {
    parseJsonBodyMock.mockResolvedValue({ target: 'ops', sender: 'dev', message: 'ping' });
    sendIntercomMessageMock.mockResolvedValue({
      success: true,
      queued: true,
      target: 'ops',
    });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/send'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendIntercomMessageMock).toHaveBeenCalledWith({ target: 'ops', sender: 'dev', message: 'ping' });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 202, {
      success: true,
      queued: true,
      target: 'ops',
    });
  });

  it('installs intercom protocol instructions', async () => {
    installIntercomProtocolMock.mockResolvedValue({ success: true, updated: ['main'], skipped: ['dev'] });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/install-protocol'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      updated: ['main'],
      skipped: ['dev'],
    });
  });

  it('deletes an intercom route', async () => {
    deleteIntercomRouteMock.mockResolvedValue({ routes: [] });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/routes/ops'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(deleteIntercomRouteMock).toHaveBeenCalledWith('ops');
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      routes: [],
    });
  });
});
