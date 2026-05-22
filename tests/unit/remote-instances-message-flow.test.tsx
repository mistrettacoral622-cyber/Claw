import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteInstances } from '@/pages/RemoteInstances';
import { useIntercomStore } from '@/stores/intercom';
import { hostApiFetch } from '@/lib/host-api';

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'remoteInstances.intercom.consoleTitle': 'Remote instance control',
        'remoteInstances.intercom.consoleDescription': 'Pick a configured Linux KTClaw and send commands.',
        'remoteInstances.intercom.refresh': 'Refresh',
        'remoteInstances.intercom.installProtocol': 'Install SOP',
        'remoteInstances.intercom.instanceListTitle': 'Instances',
        'remoteInstances.intercom.instanceCount': `${options?.count ?? 0} instances`,
        'remoteInstances.intercom.emptyRoutes': 'No Intercom routes yet',
        'remoteInstances.intercom.newRoute': 'New',
        'remoteInstances.intercom.configureTitle': 'Instance configuration',
        'remoteInstances.intercom.configureRoute': 'Configure route',
        'remoteInstances.intercom.configSheetDescription': 'Edit the SSH route used to reach this remote KTClaw instance.',
        'remoteInstances.intercom.routeReady': 'Route saved',
        'remoteInstances.intercom.unsavedRoute': 'Unsaved route',
        'remoteInstances.intercom.hostLabel': 'Host',
        'remoteInstances.intercom.sshUserLabel': 'SSH user',
        'remoteInstances.intercom.sshPortLabel': 'SSH port',
        'remoteInstances.intercom.agentIdLabel': 'Agent ID',
        'remoteInstances.intercom.sessionLabel': 'Session',
        'remoteInstances.intercom.remoteCommandLabel': 'Remote OpenClaw command',
        'remoteInstances.intercom.routeIdLabel': 'Route ID',
        'remoteInstances.intercom.displayNameLabel': 'Display name',
        'remoteInstances.intercom.saveRoute': 'Save route',
        'remoteInstances.intercom.chatTitle': 'Conversation',
        'remoteInstances.intercom.chatNeedsRoute': 'Save or select a route before sending a message.',
        'remoteInstances.intercom.senderLabel': 'Sender',
        'remoteInstances.intercom.targetLabel': 'Target',
        'remoteInstances.intercom.messagePlaceholder': 'Boss says update your avatar; reply when done',
        'remoteInstances.intercom.previewLabel': 'Command preview',
        'remoteInstances.intercom.routeNeedsSave': 'Save route before sending',
        'remoteInstances.intercom.readyToSend': 'Ready to send through SSH',
        'remoteInstances.intercom.deliveryResultTitle': 'Remote response',
        'remoteInstances.intercom.deliveryFailedTitle': 'Delivery failed',
        'remoteInstances.intercom.exitCodeLabel': 'Exit code',
        'remoteInstances.intercom.durationLabel': 'Duration',
        'remoteInstances.intercom.emptyOutput': '(empty)',
        'remoteInstances.intercom.send': 'Send',
        'remoteInstances.intercom.toasts.messageQueued': 'Message sent to Linux',
        'remoteInstances.intercom.toasts.messageDelivered': `Message delivered (${options?.code ?? 0})`,
        'remoteInstances.intercom.toasts.messageFailed': 'Failed to send message',
      };
      return table[key] ?? key;
    },
  }),
}));

const READY_INTERCOM_RESPONSE = {
  success: true,
  localHost: 'windows-dev',
  defaultSessionId: 'intercom',
  localAgents: [{ id: 'dev', name: 'Dev Agent' }],
  selfConfig: {
    host: '10.101.208.55',
    sshUser: 'tester',
    sshPort: 22,
    agentId: 'dev',
    sessionId: 'intercom',
    remoteCommand: 'openclaw',
    routeIdExample: '10.101.208.55-dev',
    displayNameExample: 'windows-dev / Dev Agent',
  },
  routes: [
    {
      id: 'linux-ktclaw',
      displayName: 'Linux KTClaw',
      host: '10.101.208.178',
      agent: 'zz',
      transport: 'ssh',
      sessionId: 'intercom',
      enabled: true,
      sshUser: 'root',
      sshPort: 22,
      remoteCommand: 'openclaw',
      source: 'config',
    },
  ],
};

function resetIntercomStore() {
  useIntercomStore.setState({
    routes: [],
    localAgents: [],
    localHost: null,
    defaultSessionId: 'intercom',
    selfConfig: null,
    loading: false,
    saving: false,
    sending: false,
    installingProtocol: false,
    error: null,
  });
}

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
    resetIntercomStore();
    vi.mocked(hostApiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/intercom' && (!init || init.method === undefined)) {
        return READY_INTERCOM_RESPONSE;
      }
      if (path === '/api/intercom/send' && init?.method === 'POST') {
        return {
          success: true,
          queued: false,
          target: 'linux-ktclaw',
          sender: 'dev',
          transport: 'ssh',
          host: '10.101.208.178',
          agent: 'zz',
          sessionId: 'intercom',
          command: 'ssh',
          args: [],
          exitCode: 0,
          stdout: '{"ok":true}',
          stderr: '',
          durationMs: 123,
        };
      }
      throw new Error(`Unexpected host api call: ${path} ${init?.method ?? 'GET'}`);
    });
  });

  it('sends the standalone remote page message through SSH intercom', async () => {
    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    expect(screen.getByText('Ready to send through SSH')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Intercom message'), {
      target: { value: 'Plan the next step' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith(
        '/api/intercom/send',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            sender: 'dev',
            target: 'linux-ktclaw',
            message: 'Plan the next step',
            sessionId: 'intercom',
          }),
        }),
      );
    });
    expect(await screen.findByText('Remote response')).toBeInTheDocument();
    expect(screen.getByText('{"ok":true}')).toBeInTheDocument();
    expect(screen.getByText('Exit code: 0')).toBeInTheDocument();
    expect(screen.queryByText('A2A context is preserved for follow-up turns')).not.toBeInTheDocument();
  });
});
