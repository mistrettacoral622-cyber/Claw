import { fireEvent, render, screen } from '@testing-library/react';
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
        'remoteInstances.intercom.send': 'Send',
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

describe('RemoteInstances page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIntercomStore();
    vi.mocked(hostApiFetch).mockResolvedValue(READY_INTERCOM_RESPONSE);
  });

  it('renders a three-column remote control console', async () => {
    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    expect(screen.getByText('Instances')).toBeInTheDocument();
    expect(screen.getByText('Conversation')).toBeInTheDocument();
    expect(screen.getAllByText('Linux KTClaw').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Intercom message')).toBeInTheDocument();
    expect(screen.queryByText('Agent Card URL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Configure route' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Instance configuration')).toBeInTheDocument();
    expect(screen.getByLabelText('Linux host')).toHaveValue('10.101.208.178');
  });
});
