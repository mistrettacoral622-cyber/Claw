import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const getIntercomSnapshotMock = vi.fn();
const upsertIntercomRouteMock = vi.fn();
const deleteIntercomRouteMock = vi.fn();
const sendIntercomMessageMock = vi.fn();
const sendIntercomTaskMock = vi.fn();
const uploadIntercomFilesMock = vi.fn();
const downloadIntercomArtifactsMock = vi.fn();
const installIntercomProtocolMock = vi.fn();
const getIntercomHostReadinessMock = vi.fn();
const prepareIntercomHostMock = vi.fn();

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/services/intercom', () => ({
  getIntercomSnapshot: (...args: unknown[]) => getIntercomSnapshotMock(...args),
  getIntercomHostReadiness: (...args: unknown[]) => getIntercomHostReadinessMock(...args),
  upsertIntercomRoute: (...args: unknown[]) => upsertIntercomRouteMock(...args),
  deleteIntercomRoute: (...args: unknown[]) => deleteIntercomRouteMock(...args),
  sendIntercomMessage: (...args: unknown[]) => sendIntercomMessageMock(...args),
  sendIntercomTask: (...args: unknown[]) => sendIntercomTaskMock(...args),
  uploadIntercomFiles: (...args: unknown[]) => uploadIntercomFilesMock(...args),
  downloadIntercomArtifacts: (...args: unknown[]) => downloadIntercomArtifactsMock(...args),
  installIntercomProtocol: (...args: unknown[]) => installIntercomProtocolMock(...args),
  prepareIntercomHost: (...args: unknown[]) => prepareIntercomHostMock(...args),
}));

describe('intercom routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getIntercomSnapshotMock.mockResolvedValue({ routes: [] });
    getIntercomHostReadinessMock.mockResolvedValue({ ready: true, checks: [] });
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

  it('returns host readiness', async () => {
    getIntercomHostReadinessMock.mockResolvedValue({ ready: false, checks: [{ id: 'ssh-listener' }] });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/host-readiness'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      ready: false,
      checks: [{ id: 'ssh-listener' }],
    });
  });

  it('starts host preparation', async () => {
    prepareIntercomHostMock.mockResolvedValue({ success: true, started: true, status: { ready: true } });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/prepare-host'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(prepareIntercomHostMock).toHaveBeenCalledWith();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      started: true,
      status: { ready: true },
    });
  });

  it('queues an intercom message', async () => {
    parseJsonBodyMock.mockResolvedValue({ target: 'ops', sender: 'dev', message: 'ping' });
    sendIntercomMessageMock.mockResolvedValue({
      success: true,
      queued: false,
      target: 'ops',
      stdout: '{"ok":true}',
      stderr: '',
      exitCode: 0,
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
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      queued: false,
      target: 'ops',
      stdout: '{"ok":true}',
      stderr: '',
      exitCode: 0,
    });
  });

  it('returns captured intercom command failures', async () => {
    parseJsonBodyMock.mockResolvedValue({ target: 'ops', sender: 'dev', message: 'ping' });
    const error = new Error('Intercom command failed: ssh failed');
    Object.assign(error, {
      exitCode: 255,
      stdout: '',
      stderr: 'ssh failed',
      durationMs: 42,
    });
    sendIntercomMessageMock.mockRejectedValue(error);
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/send'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 502, {
      success: false,
      error: 'Intercom command failed: ssh failed',
      exitCode: 255,
      stdout: '',
      stderr: 'ssh failed',
      durationMs: 42,
    });
  });

  it('sends a structured remote task through intercom', async () => {
    parseJsonBodyMock.mockResolvedValue({
      target: 'ops',
      sender: 'dev',
      action: 'inspect_file',
      payload: { path: '/tmp/report.md' },
    });
    sendIntercomTaskMock.mockResolvedValue({
      success: true,
      taskId: 'task-1',
      result: {
        success: true,
        summary: 'done',
        artifacts: [],
        logs: 'ok',
        error: null,
      },
    });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/tasks'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendIntercomTaskMock).toHaveBeenCalledWith({
      target: 'ops',
      sender: 'dev',
      action: 'inspect_file',
      payload: { path: '/tmp/report.md' },
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      taskId: 'task-1',
      result: {
        success: true,
        summary: 'done',
        artifacts: [],
        logs: 'ok',
        error: null,
      },
    });
  });

  it('exposes intercom file upload transfers', async () => {
    parseJsonBodyMock.mockResolvedValue({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      files: [{ localPath: '/tmp/a.txt' }],
    });
    uploadIntercomFilesMock.mockResolvedValue({ success: true, taskId: 'task-1', transfers: [{ remotePath: '~/.ktclaw/intercom/inbox/dev/task-1/a.txt' }] });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/transfers/upload'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(uploadIntercomFilesMock).toHaveBeenCalledWith({
      target: 'ops',
      sender: 'dev',
      taskId: 'task-1',
      files: [{ localPath: '/tmp/a.txt' }],
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      taskId: 'task-1',
      transfers: [{ remotePath: '~/.ktclaw/intercom/inbox/dev/task-1/a.txt' }],
    });
  });

  it('exposes intercom artifact download transfers', async () => {
    parseJsonBodyMock.mockResolvedValue({
      target: 'ops',
      taskId: 'task-1',
      artifacts: [{ path: '~/.ktclaw/intercom/outbox/task-1/result.png' }],
    });
    downloadIntercomArtifactsMock.mockResolvedValue({ success: true, taskId: 'task-1', transfers: [{ localPath: '/tmp/result.png' }] });
    const { handleIntercomRoutes } = await import('@electron/api/routes/intercom');

    const handled = await handleIntercomRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/intercom/transfers/download'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(downloadIntercomArtifactsMock).toHaveBeenCalledWith({
      target: 'ops',
      taskId: 'task-1',
      artifacts: [{ path: '~/.ktclaw/intercom/outbox/task-1/result.png' }],
    });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      taskId: 'task-1',
      transfers: [{ localPath: '/tmp/result.png' }],
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
