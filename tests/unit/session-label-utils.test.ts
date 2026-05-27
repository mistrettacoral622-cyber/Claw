import { describe, expect, it } from 'vitest';
import { deriveSessionLabelFromMessages } from '@/stores/chat/session-label-utils';

describe('session label utils', () => {
  it('skips gateway metadata and heartbeat messages', () => {
    const label = deriveSessionLabelFromMessages([
      {
        role: 'user',
        content: 'Conversation info (untrusted metadata): ```json\n{"cwd":"/tmp"}\n```\nheartbeat',
      },
      {
        role: 'assistant',
        content: 'ok',
      },
      {
        role: 'user',
        content: 'Help me polish the sidebar',
      },
    ]);

    expect(label).toBe('Help me polish the sidebar');
  });

  it('cleans dispatch and attachment metadata before truncating', () => {
    const label = deriveSessionLabelFromMessages([
      {
        role: 'user',
        content: '[KTCLAW_DISPATCH_HINTS]hidden[/KTCLAW_DISPATCH_HINTS] Review this screen [media attached: C:\\tmp\\a.png (image/png) | a.png]',
      },
    ]);

    expect(label).toBe('Review this screen');
  });
});
