import type { IncomingMessage, ServerResponse } from 'http';
import { PORTS } from '../../utils/config';
import { listAgentsSnapshot } from '../../utils/agent-config';
import { buildOpenClawControlUiUrl } from '../../utils/openclaw-control-ui';
import { isOutboundMediaPath } from '../../utils/outbound-media';
import { isGeneratedMediaPath } from '../../utils/generated-media';
import { appendDispatchHints } from '../../../shared/chat-dispatch-hints';
import {
  appendMediaReferences,
  buildMediaReference,
  isTextOnlyImageSchemaError,
  isVisionMimeType,
} from '../../../shared/chat-media-attachments';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleGatewayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/app/gateway-info' && req.method === 'GET') {
    const status = ctx.gatewayManager.getStatus();
    const port = status.port || PORTS.OPENCLAW_GATEWAY;
    sendJson(res, 200, {
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      port,
    });
    return true;
  }

  if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
    sendJson(res, 200, ctx.gatewayManager.getStatus());
    return true;
  }

  if (url.pathname === '/api/gateway/health' && req.method === 'GET') {
    const health = await ctx.gatewayManager.checkHealth();
    sendJson(res, 200, health);
    return true;
  }

  if (url.pathname === '/api/gateway/start' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.start();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/stop' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.stop();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/restart' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.restart();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/control-ui' && req.method === 'GET') {
    try {
      const status = ctx.gatewayManager.getStatus();
      const port = status.port || PORTS.OPENCLAW_GATEWAY;
      const urlValue = buildOpenClawControlUiUrl(port, '').split('#')[0];
      sendJson(res, 200, { success: true, url: urlValue, port });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/chat/send-with-media' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey: string;
        message: string;
        cwd?: string;
        deliver?: boolean;
        idempotencyKey: string;
        media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      }>(req);
      const imageAttachments: Array<{ content: string; mimeType: string; fileName: string }> = [];
      const fileReferences: string[] = [];
      if (body.media && body.media.length > 0) {
        const invalidMedia = body.media.find((m) => !isOutboundMediaPath(m.filePath) && !isGeneratedMediaPath(m.filePath));
        if (invalidMedia) {
          sendJson(res, 400, { success: false, error: 'MEDIA_PATH_NOT_STAGED', filePath: invalidMedia.filePath });
          return true;
        }
        const fsP = await import('node:fs/promises');
        for (const m of body.media) {
          const mediaReference = buildMediaReference(m);

          if (isVisionMimeType(m.mimeType)) {
            const fileBuffer = await fsP.readFile(m.filePath);
            imageAttachments.push({
              content: fileBuffer.toString('base64'),
              mimeType: m.mimeType,
              fileName: m.fileName,
            });
            continue;
          }

          fileReferences.push(mediaReference);
        }
      }

      const dispatchAwareMessage = appendDispatchHints(body.message, body.media);
      const message = fileReferences.length > 0
        ? [dispatchAwareMessage, ...fileReferences].filter(Boolean).join('\n')
        : dispatchAwareMessage;
      const snapshot = await listAgentsSnapshot().catch(() => null);
      const blockedAgent = snapshot?.agents.find((agent) => (
        agent.chatAccess === 'leader_only' && agent.mainSessionKey === body.sessionKey
      ));
      if (blockedAgent) {
        sendJson(res, 403, {
          success: false,
          error: 'LEADER_ONLY_DIRECT_CHAT_BLOCKED',
          sessionKey: body.sessionKey,
        });
        return true;
      }
      const normalizedCwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
      const rpcParams: Record<string, unknown> = {
        sessionKey: body.sessionKey,
        message,
        deliver: body.deliver ?? false,
        idempotencyKey: body.idempotencyKey,
        ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
      };
      if (imageAttachments.length > 0) {
        rpcParams.attachments = imageAttachments;
      }
      let result: unknown;
      try {
        result = await ctx.gatewayManager.rpc('chat.send', rpcParams, 120000);
      } catch (error) {
        if (imageAttachments.length === 0 || !isTextOnlyImageSchemaError(error)) {
          throw error;
        }

        const fallbackVisionMedia = body.media?.filter((item) => isVisionMimeType(item.mimeType)) ?? [];
        const fallbackRpcParams: Record<string, unknown> = {
          ...rpcParams,
          message: appendMediaReferences(message, fallbackVisionMedia),
          idempotencyKey: `${body.idempotencyKey}:text-only-media-fallback`,
        };
        delete fallbackRpcParams.attachments;
        result = await ctx.gatewayManager.rpc('chat.send', fallbackRpcParams, 120000);
      }
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
