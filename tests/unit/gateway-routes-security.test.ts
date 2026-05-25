import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const getSettingMock = vi.fn();
const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const buildOpenClawControlUiUrlMock = vi.fn(() => 'http://127.0.0.1:18789/#token=secret-token');
const listAgentsSnapshotMock = vi.fn();
const expandPathMock = vi.fn((p: string) => p.replace('~', homedir()));
const writeFileMock = vi.fn();
const readdirMock = vi.fn();
const readFileMock = vi.fn();

vi.mock('@electron/utils/store', () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/utils/openclaw-control-ui', () => ({
  buildOpenClawControlUiUrl: (...args: unknown[]) => buildOpenClawControlUiUrlMock(...args),
}));

vi.mock('@electron/utils/agent-config', () => ({
  listAgentsSnapshot: (...args: unknown[]) => listAgentsSnapshotMock(...args),
}));

vi.mock('../../utils/paths', () => ({
  expandPath: (...args: unknown[]) => expandPathMock(...args as [string]),
}));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  readdir: (...args: unknown[]) => readdirMock(...args),
}));

describe('gateway routes security', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getSettingMock.mockResolvedValue('secret-token');
    readFileMock.mockResolvedValue(Buffer.from('image-bytes'));
    listAgentsSnapshotMock.mockResolvedValue({
      agents: [
        { id: 'main', mainSessionKey: 'agent:main:main', chatAccess: 'direct', workspace: '~/.openclaw/workspace' },
        { id: 'research', mainSessionKey: 'agent:research:main', chatAccess: 'leader_only', workspace: '~/.openclaw/workspace-research' },
      ],
    });
  });

  it('does not expose the gateway token from gateway-info', async () => {
    const { handleGatewayRoutes } = await import('@electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/app/gateway-info'),
      {
        gatewayManager: {
          getStatus: () => ({ state: 'running', port: 18789 }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      wsUrl: 'ws://127.0.0.1:18789/ws',
      port: 18789,
    });
  });

  it('does not return a tokenized control-ui URL payload', async () => {
    const { handleGatewayRoutes } = await import('@electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/control-ui'),
      {
        gatewayManager: {
          getStatus: () => ({ state: 'running', port: 18789 }),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      url: 'http://127.0.0.1:18789/',
      port: 18789,
    });
  });

  it('rejects non-staged media paths for send-with-media', async () => {
    const { handleGatewayRoutes } = await import('@electron/api/routes/gateway');
    const rpcMock = vi.fn();
    const filePath = join(homedir(), 'not-staged.png');
    parseJsonBodyMock.mockResolvedValue({
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

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/chat/send-with-media'),
      {
        gatewayManager: {
          rpc: rpcMock,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, {
      success: false,
      error: 'MEDIA_PATH_NOT_STAGED',
      filePath,
    });
  });

  it('rejects leader-only worker direct sends before forwarding to gateway chat.send', async () => {
    const { handleGatewayRoutes } = await import('@electron/api/routes/gateway');
    const rpcMock = vi.fn();
    parseJsonBodyMock.mockResolvedValue({
      sessionKey: 'agent:research:main',
      message: 'hello',
      idempotencyKey: 'idem-2',
      media: [],
    });

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/chat/send-with-media'),
      {
        gatewayManager: {
          rpc: rpcMock,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 403, {
      success: false,
      error: 'LEADER_ONLY_DIRECT_CHAT_BLOCKED',
      sessionKey: 'agent:research:main',
    });
  });

  it('does not append local path references for image attachments in send-with-media', async () => {
    const { handleGatewayRoutes } = await import('@electron/api/routes/gateway');
    const rpcMock = vi.fn(async () => ({ runId: 'run-image' }));
    const imagePath = join(homedir(), '.openclaw', 'media', 'outbound', 'vision.png');
    parseJsonBodyMock.mockResolvedValue({
      sessionKey: 'session-1',
      message: 'Describe this image',
      idempotencyKey: 'idem-image',
      media: [
        {
          filePath: imagePath,
          mimeType: 'image/png',
          fileName: 'vision.png',
        },
      ],
    });
    readdirMock.mockResolvedValue([]);

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/chat/send-with-media'),
      {
        gatewayManager: {
          rpc: rpcMock,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpcMock).toHaveBeenCalled();
    const [, rpcParams] = rpcMock.mock.calls[0] as [string, { message: string; attachments?: unknown[] }];
    expect(rpcParams.attachments?.length).toBe(1);
    expect(rpcParams.message).not.toContain(imagePath);
    expect(rpcParams.message).toContain('Describe this image');
  });

  it('retries image sends as text-only file references when the Gateway rejects image_url content', async () => {
    const { handleGatewayRoutes } = await import('@electron/api/routes/gateway');
    const rpcMock = vi.fn()
      .mockRejectedValueOnce(new Error('400 Failed to deserialize the JSON body into the target type: messages[75]: unknown variant image_url, expected text'))
      .mockResolvedValueOnce({ runId: 'run-fallback' });
    const imagePath = join(homedir(), '.openclaw', 'media', 'outbound', 'vision.png');
    parseJsonBodyMock.mockResolvedValue({
      sessionKey: 'session-1',
      message: 'Describe this image',
      idempotencyKey: 'idem-image',
      media: [
        {
          filePath: imagePath,
          mimeType: 'image/png',
          fileName: 'vision.png',
        },
      ],
    });

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/chat/send-with-media'),
      {
        gatewayManager: {
          rpc: rpcMock,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(2);
    const [, firstParams] = rpcMock.mock.calls[0] as [string, { message: string; attachments?: unknown[] }];
    const [, secondParams] = rpcMock.mock.calls[1] as [string, { message: string; attachments?: unknown[]; idempotencyKey?: string }];
    expect(firstParams.attachments?.length).toBe(1);
    expect(firstParams.message).not.toContain(imagePath);
    expect(secondParams.attachments).toBeUndefined();
    expect(secondParams.idempotencyKey).toBe('idem-image:text-only-media-fallback');
    expect(secondParams.message).toContain(`[media attached: ${imagePath} (image/png) | ${imagePath}]`);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      result: { runId: 'run-fallback' },
    });
  });

  it('allows generated media paths for follow-up sends', async () => {
    const { handleGatewayRoutes } = await import('@electron/api/routes/gateway');
    const rpcMock = vi.fn(async () => ({ runId: 'run-generated' }));
    const imagePath = join(homedir(), '.openclaw', 'media', 'generated', 'vision.png');
    parseJsonBodyMock.mockResolvedValue({
      sessionKey: 'session-1',
      message: '继续分析这张图',
      idempotencyKey: 'idem-generated',
      media: [
        {
          filePath: imagePath,
          mimeType: 'image/png',
          fileName: 'vision.png',
        },
      ],
    });

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/chat/send-with-media'),
      {
        gatewayManager: {
          rpc: rpcMock,
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpcMock).toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      result: { runId: 'run-generated' },
    });
  });

  it('PUT /api/agents/:id/workspace/AGENTS.md writes file when content provided', async () => {
    const { handleAgentRoutes } = await import('@electron/api/routes/agents');
    writeFileMock.mockResolvedValue(undefined);
    parseJsonBodyMock.mockResolvedValue({ content: '# New AGENTS.md content' });

    const handled = await handleAgentRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/agents/main/workspace/AGENTS.md'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
    expect(writeFileMock).toHaveBeenCalled();
  });

  it('PUT /api/agents/:id/workspace/TOOLS.md returns 400 for non-writable file', async () => {
    const { handleAgentRoutes } = await import('@electron/api/routes/agents');
    parseJsonBodyMock.mockResolvedValue({ content: 'some content' });

    const handled = await handleAgentRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/agents/main/workspace/TOOLS.md'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, {
      success: false,
      error: 'File not writable',
    });
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('GET /api/agents/:id/workspace/skills returns empty array when no workspace', async () => {
    const { handleAgentRoutes } = await import('@electron/api/routes/agents');
    listAgentsSnapshotMock.mockResolvedValue({
      agents: [
        { id: 'no-workspace', mainSessionKey: 'agent:no-workspace:main', chatAccess: 'direct' },
      ],
    });

    const handled = await handleAgentRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/agents/no-workspace/workspace/skills'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      skills: [],
    });
  });

  it('GET /api/agents/:id/workspace/skills/:name validates skill name with path traversal', async () => {
    const { handleAgentRoutes } = await import('@electron/api/routes/agents');

    const handled = await handleAgentRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/agents/main/workspace/skills/..%2Fetc'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, {
      success: false,
      error: 'Invalid skill name',
    });
  });
});
