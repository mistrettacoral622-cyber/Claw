import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionItem } from '@/components/sessions/SessionItem';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'teamMap.session.leaderChatBadge': 'LEADER_BADGE',
      };
      return translations[key] ?? (typeof options?.defaultValue === 'string' ? options.defaultValue : key);
    },
  }),
}));

describe('SessionItem', () => {
  it('renders a leader-chat indicator for private leader sessions', () => {
    render(
      <SessionItem
        session={{
          key: 'agent:main:private-main',
          displayName: 'Main',
          updatedAt: Date.now(),
          isPrivateChat: true,
          isLeaderChat: true,
          agentStatus: 'online',
        }}
        label="Main"
        isPinned={false}
        isActive={false}
        onClick={vi.fn()}
        onPinToggle={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('LEADER_BADGE')).toBeInTheDocument();
  });

  it('invokes handlers for click, pin, and delete actions', () => {
    const onClick = vi.fn();
    const onPinToggle = vi.fn();
    const onDelete = vi.fn();

    render(
      <SessionItem
        session={{
          key: 'agent:research:private-research',
          updatedAt: Date.now(),
          agentStatus: 'online',
        }}
        label="Research"
        isPinned={false}
        isActive={false}
        onClick={onClick}
        onPinToggle={onPinToggle}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open session Research' }));
    fireEvent.click(screen.getByLabelText('Session actions'));
    fireEvent.click(screen.getByLabelText('Pin'));
    fireEvent.click(screen.getByLabelText('Session actions'));
    fireEvent.click(screen.getByLabelText('Delete'));

    expect(onClick).toHaveBeenCalled();
    expect(onPinToggle).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
  });

  it('does not render a zero unread count', () => {
    render(
      <SessionItem
        session={{
          key: 'agent:main:session-123',
          unreadCount: 0,
        }}
        label="Design polish"
        agentName="Main"
        isPinned={false}
        isActive={true}
        onClick={vi.fn()}
        onPinToggle={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open session Design polish' }))
      .toHaveAttribute('title', 'Design polish - Agent Main');
  });

  it('falls back from infrastructure labels to the session key title', () => {
    render(
      <SessionItem
        session={{
          key: 'agent:main:session-456',
        }}
        label={'Conversation info (untrusted metadata): ```json\n{"cwd":"/tmp"}\n```'}
        agentName="Main"
        isPinned={false}
        isActive={false}
        onClick={vi.fn()}
        onPinToggle={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('Session 456')).toBeInTheDocument();
    expect(screen.queryByText(/Conversation info/)).not.toBeInTheDocument();
  });
});
