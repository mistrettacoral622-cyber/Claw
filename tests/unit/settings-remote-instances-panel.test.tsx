import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRemoteInstancesPanel } from '@/components/settings-center/settings-remote-instances-panel';
import { useIntercomStore } from '@/stores/intercom';
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
        'remoteInstances.intercom.settingsTitle': 'Remote instance management',
        'remoteInstances.intercom.settingsHeading': 'Configured intercom instances',
        'remoteInstances.intercom.settingsDescription': 'Review saved SSH routes and local agent identity here.',
        'remoteInstances.intercom.refresh': 'Refresh',
        'remoteInstances.intercom.installProtocol': 'Install SOP',
        'remoteInstances.intercom.openConsole': 'Open console',
        'remoteInstances.intercom.selfTitle': 'This KTClaw',
        'remoteInstances.intercom.localHostLabel': 'Local host',
        'remoteInstances.intercom.defaultSessionLabel': 'Default session',
        'remoteInstances.intercom.localAgentsLabel': 'Local agents',
        'remoteInstances.intercom.noLocalAgents': 'No local agents',
        'remoteInstances.intercom.configuredInstancesTitle': 'Configured instances',
        'remoteInstances.intercom.instanceCount': `${options?.count ?? 0} instances`,
        'remoteInstances.intercom.emptyRoutes': 'No Intercom routes yet',
        'remoteInstances.intercom.agentIdLabel': 'Agent ID',
        'remoteInstances.intercom.sessionLabel': 'Session',
        'remoteInstances.intercom.remoteCommandLabel': 'Remote OpenClaw command',
        'remoteInstances.intercom.enabledLabel': 'Enabled',
        'remoteInstances.intercom.disabledLabel': 'Disabled',
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
    loading: false,
    saving: false,
    sending: false,
    installingProtocol: false,
    error: null,
  });
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <SettingsRemoteInstancesPanel />
    </MemoryRouter>,
  );
}

describe('SettingsRemoteInstancesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIntercomStore();
    vi.mocked(hostApiFetch).mockResolvedValue(READY_INTERCOM_RESPONSE);
  });

  it('shows remote intercom management without exposing the A2A Agent Card setup', async () => {
    renderPanel();

    expect(await screen.findByText('Remote instance management')).toBeInTheDocument();
    expect(screen.getByText('This KTClaw')).toBeInTheDocument();
    expect(screen.getByText('Configured instances')).toBeInTheDocument();
    expect(screen.getByText('windows-dev')).toBeInTheDocument();
    expect(screen.getByText('Dev Agent')).toBeInTheDocument();
    expect(screen.getByText('Linux KTClaw')).toBeInTheDocument();
    expect(screen.getByText('ssh root@10.101.208.178 -p 22')).toBeInTheDocument();

    expect(screen.queryByText('Agent Card URL')).not.toBeInTheDocument();
    expect(screen.queryByText('My Agent Card URL')).not.toBeInTheDocument();
    expect(screen.queryByText('Enable inbound')).not.toBeInTheDocument();
  });
});
