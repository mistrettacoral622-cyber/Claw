import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteInstances } from '@/pages/RemoteInstances';
import { useRemoteInstancesStore, type RemoteInstance } from '@/stores/remote-instances';
import { hostApiFetch } from '@/lib/host-api';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

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
      { id: 'search', label: 'Search', description: null },
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

describe('RemoteInstances page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRemoteInstancesStore.getState().reset();
    vi.mocked(hostApiFetch).mockResolvedValue({ instances: [BASE_INSTANCE] });
  });

  it('renders a dedicated left-list and center conversation workspace', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: '远程实例' })).toBeInTheDocument();
    expect(screen.getAllByText('Edge Assistant').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Remote conversation').length).toBeGreaterThan(0);
    expect(screen.getByText('Start the remote thread')).toBeInTheDocument();
    expect(screen.getByLabelText('Message this remote instance')).toBeInTheDocument();
    expect(screen.getByText(/不进入全局会话列表/)).toBeInTheDocument();
  });

  it('selects an instance and exposes Agent Card diagnostics in the details drawer', async () => {
    renderPage();

    await screen.findAllByText('Edge Assistant');
    fireEvent.click(screen.getByRole('button', { name: '详情' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Agent Card')).toBeInTheDocument();
    expect(screen.getByText('Agent Card reachable')).toBeInTheDocument();
    expect(screen.getAllByText('text/plain').length).toBeGreaterThan(0);
  });

  it('navigates to Settings for remote-instance management without using global sessions', async () => {
    renderPage();

    await screen.findAllByText('Edge Assistant');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/settings?section=remote-instances');
    });
  });
});
