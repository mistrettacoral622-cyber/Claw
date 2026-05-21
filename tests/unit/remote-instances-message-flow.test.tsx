import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteInstances } from '@/pages/RemoteInstances';
import { hostApiFetch } from '@/lib/host-api';
import { useRemoteInstancesStore, type RemoteInstance } from '@/stores/remote-instances';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('@/pages/Chat/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

const BASE_INSTANCE: RemoteInstance = {
  id: 'remote-1',
  displayName: 'Edge Assistant',
  agentCardUrl: 'https://edge.example/.well-known/agent-card.json',
  authMode: 'none',
  bearerToken: null,
  headers: {},
  agentCard: {
    name: 'Edge Assistant',
    description: 'Handles remote planning tasks.',
    version: '2026.4.8',
    url: 'https://edge.example/.well-known/agent-card.json',
    capabilities: [
      { id: 'chat', label: 'Chat', description: 'Accepts multi-turn messages' },
    ],
    skills: ['planner'],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  },
  lastTest: {
    ok: true,
    status: 'ok',
    message: 'Agent Card reachable',
    checkedAt: '2026-05-20T08:00:00.000Z',
  },
  createdAt: '2026-05-20T07:30:00.000Z',
  updatedAt: '2026-05-20T08:00:00.000Z',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/remote-instances']}>
      <RemoteInstances />
    </MemoryRouter>,
  );
}

describe('RemoteInstances message flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useRemoteInstancesStore.getState().reset();
    vi.mocked(hostApiFetch)
      .mockResolvedValueOnce({ instances: [BASE_INSTANCE] })
      .mockResolvedValueOnce({
        context_id: 'ctx-remote-1',
        task_id: 'task-remote-1',
        message: {
          role: 'assistant',
          content: 'Remote reply',
        },
      });
  });

  it('sends a remote message, renders the reply, and keeps continuity metadata visible', async () => {
    renderPage();

    expect(await screen.findAllByText('Edge Assistant')).not.toHaveLength(0);
    expect(screen.getByText('Start the remote thread')).toBeInTheDocument();
    expect(screen.getAllByText('Chat').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Message this remote instance'), {
      target: { value: 'Plan the next step' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send remote message' }));

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith(
        '/api/remote-instances/remote-1/conversation/messages',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"message":"Plan the next step"'),
        }),
      );
    });

    expect(await screen.findByText('Plan the next step')).toBeInTheDocument();
    expect(await screen.findByText('Remote reply')).toBeInTheDocument();
    expect(screen.getByText('context_id: ctx-remote-1')).toBeInTheDocument();
    expect(screen.getAllByText('task_id: task-remote-1').length).toBeGreaterThan(0);
  });
});
