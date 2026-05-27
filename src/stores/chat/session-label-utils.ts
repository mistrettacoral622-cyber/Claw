type MessageLike = {
  role?: unknown;
  content?: unknown;
};

function getTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const text = (block as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

export function cleanSessionLabelText(text: string): string {
  return text
    .replace(/\s*\[KTCLAW_DISPATCH_HINTS\][\s\S]*?\[\/KTCLAW_DISPATCH_HINTS\]\s*/g, '\n')
    .replace(/^Conversation info\s*\([^)]*\):\s*```[a-z-]*\r?\n[\s\S]*?```\s*/i, '')
    .replace(/^Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/i, '')
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isInfrastructureSessionLabel(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === 'heartbeat'
    || normalized.startsWith('conversation info')
    || /^system:\s*\[/.test(text)
    || /a scheduled reminder has been triggered/i.test(text)
    || /\[cron:[^\]]+\]/i.test(text);
}

export function deriveSessionLabelFromMessages(messages: MessageLike[], maxLength = 50): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const cleaned = cleanSessionLabelText(getTextContent(message.content));
    if (isInfrastructureSessionLabel(cleaned)) continue;
    return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
  }
  return '';
}
