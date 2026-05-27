import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRemoteInstancesPanel } from '@/components/settings-center/settings-remote-instances-panel';
import { useIntercomStore } from '@/stores/intercom';
import { hostApiFetch } from '@/lib/host-api';

const navigateMock = vi.fn();
const clipboardWriteTextMock = vi.fn();

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
        'remoteInstances.intercom.selfShareTitle': 'Config others should enter',
        'remoteInstances.intercom.selfShareDescription': 'Give these values to another KTClaw user so they can add this machine as an SSH Intercom route. Host is the detected LAN IP when available.',
        'remoteInstances.intercom.hostReady': 'Ready',
        'remoteInstances.intercom.hostNeedsSetup': 'Needs setup',
        'remoteInstances.intercom.hostReadyDescription': 'This machine looks ready for other KTClaw instances to connect.',
        'remoteInstances.intercom.hostNeedsSetupDescription': 'This machine still needs SSH or network setup before others can connect.',
        'remoteInstances.intercom.hostPrepareAdminHint': 'Preparation may open a system administrator prompt.',
        'remoteInstances.intercom.hostPrepareNoAdminHint': 'Preparation can run without administrator changes.',
        'remoteInstances.intercom.prepareHost': 'Prepare this machine',
        'remoteInstances.intercom.hostAccessToggleLabel': 'Allow remote connections',
        'remoteInstances.intercom.hostAccessToggleOnDescription': 'SSH access is open.',
        'remoteInstances.intercom.hostAccessToggleOffDescription': 'SSH access is closed.',
        'remoteInstances.intercom.hostAccessOn': 'Open',
        'remoteInstances.intercom.hostAccessOff': 'Closed',
        'remoteInstances.intercom.hostChecksLabel': 'Connection checks',
        'remoteInstances.intercom.selfHostToShareLabel': 'SSH host/IP for others',
        'remoteInstances.intercom.selfSshUserLabel': 'SSH user on this machine',
        'remoteInstances.intercom.selfRouteExampleLabel': 'Route example',
        'remoteInstances.intercom.copyConnectionInfo': 'Copy connection info',
        'remoteInstances.intercom.unknownSshUser': 'Fill manually',
        'remoteInstances.intercom.localHostLabel': 'Local host',
        'remoteInstances.intercom.defaultSessionLabel': 'Default session',
        'remoteInstances.intercom.localAgentsLabel': 'Local agents',
        'remoteInstances.intercom.noLocalAgents': 'No local agents',
        'remoteInstances.intercom.configuredInstancesTitle': 'Configured instances',
        'remoteInstances.intercom.instanceCount': `${options?.count ?? 0} instances`,
        'remoteInstances.intercom.emptyRoutes': 'No Intercom routes yet',
        'remoteInstances.intercom.routeIdLabel': 'Route ID',
        'remoteInstances.intercom.displayNameLabel': 'Display name',
        'remoteInstances.intercom.agentIdLabel': 'Agent ID',
        'remoteInstances.intercom.sessionLabel': 'Session',
        'remoteInstances.intercom.sshPortLabel': 'SSH port',
        'remoteInstances.intercom.sshPasswordLabel': 'SSH password',
        'remoteInstances.intercom.passwordConfigured': 'Saved',
        'remoteInstances.intercom.passwordNotConfigured': 'Not saved',
        'remoteInstances.intercom.remoteCommandLabel': 'Remote OpenClaw command',
        'remoteInstances.intercom.enabledLabel': 'Enabled',
        'remoteInstances.intercom.disabledLabel': 'Disabled',
        'remoteInstances.intercom.toasts.hostPrepared': 'Host prepared',
        'remoteInstances.intercom.toasts.hostPrepareFailed': 'Host prepare failed',
        'remoteInstances.intercom.toasts.hostAccessEnabled': 'Remote access opened',
        'remoteInstances.intercom.toasts.hostAccessDisabled': 'Remote access closed',
        'remoteInstances.intercom.toasts.hostAccessFailed': 'Remote access failed',
        'remoteInstances.intercom.toasts.connectionInfoCopied': 'Connection info copied',
        'remoteInstances.intercom.toasts.connectionInfoCopyFailed': 'Connection info copy failed',
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
      sshPasswordConfigured: true,
      remoteCommand: 'openclaw',
      source: 'config',
    },
  ],
};

const READY_HOST_RESPONSE = {
  success: true,
  ready: true,
  accessEnabled: true,
  platform: 'win32',
  canPrepare: true,
  needsAdmin: true,
  host: '10.101.208.55',
  sshUser: 'tester',
  sshPort: 22,
  agentId: 'dev',
  sessionId: 'intercom',
  remoteCommand: 'openclaw',
  checks: [
    {
      id: 'ssh-listener',
      status: 'ok',
      title: 'SSH listener',
      detail: 'SSH is accepting local connections on port 22.',
    },
  ],
  prepareCommandPreview: 'Start-Service sshd',
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
    preparingHost: false,
    settingHostAccess: false,
    error: null,
    hostReadiness: null,
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
    clipboardWriteTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
    resetIntercomStore();
    vi.mocked(hostApiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/intercom/host-readiness') {
        return READY_HOST_RESPONSE;
      }
      if (path === '/api/intercom/prepare-host' && init?.method === 'POST') {
        return {
          success: true,
          started: true,
          stdout: '',
          stderr: '',
          error: null,
          status: READY_HOST_RESPONSE,
        };
      }
      if (path === '/api/intercom/host-access' && init?.method === 'POST') {
        return {
          success: true,
          started: true,
          stdout: '',
          stderr: '',
          error: null,
          status: {
            ...READY_HOST_RESPONSE,
            ready: false,
            accessEnabled: false,
          },
        };
      }
      return READY_INTERCOM_RESPONSE;
    });
  });

  it('shows remote intercom management without exposing the A2A Agent Card setup', async () => {
    renderPanel();

    expect(await screen.findByText('Remote instance management')).toBeInTheDocument();
    expect(screen.getByText('This KTClaw')).toBeInTheDocument();
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Connection checks')).toBeInTheDocument();
    expect(screen.getByText('Allow remote connections')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Allow remote connections' })).toBeChecked();
    expect(screen.getByText('SSH listener')).toBeInTheDocument();
    expect(screen.getByText('Config others should enter')).toBeInTheDocument();
    expect(screen.getByText('SSH host/IP for others')).toBeInTheDocument();
    expect(screen.getByText('SSH user on this machine')).toBeInTheDocument();
    expect(screen.getByText('Route example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy connection info' })).toBeInTheDocument();
    expect(screen.getByText('Configured instances')).toBeInTheDocument();
    expect(screen.getAllByText('windows-dev').length).toBeGreaterThan(0);
    expect(screen.getByText('10.101.208.55')).toBeInTheDocument();
    expect(screen.getByText('tester')).toBeInTheDocument();
    expect(screen.getByText('ssh tester@10.101.208.55 -p 22')).toBeInTheDocument();
    expect(document.body.textContent).toContain('Route ID: 10.101.208.55-dev');
    expect(document.body.textContent).toContain('Display name: windows-dev / Dev Agent');
    expect(screen.getByText('Dev Agent')).toBeInTheDocument();
    expect(screen.getByText('Linux KTClaw')).toBeInTheDocument();
    expect(screen.getByText('ssh root@10.101.208.178 -p 22')).toBeInTheDocument();
    expect(document.body.textContent).toContain('SSH password: Saved');

    expect(screen.queryByText('Agent Card URL')).not.toBeInTheDocument();
    expect(screen.queryByText('My Agent Card URL')).not.toBeInTheDocument();
    expect(screen.queryByText('Enable inbound')).not.toBeInTheDocument();
  });

  it('can launch the host preparation flow from settings', async () => {
    renderPanel();

    expect(await screen.findByText('Remote instance management')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare this machine' }));

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith('/api/intercom/prepare-host', {
        method: 'POST',
      });
    });
  });

  it('can close host remote access from settings', async () => {
    renderPanel();

    expect(await screen.findByText('Remote instance management')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Allow remote connections' }));

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith('/api/intercom/host-access', {
        method: 'POST',
        body: JSON.stringify({ enabled: false }),
      });
    });
  });

  it('copies a pasteable connection info bundle from settings', async () => {
    renderPanel();

    expect(await screen.findByText('Remote instance management')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy connection info' }));

    await waitFor(() => {
      expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('"type": "ktclaw-intercom-route"'));
      expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('"host": "10.101.208.55"'));
      expect(clipboardWriteTextMock).toHaveBeenCalledWith(expect.stringContaining('"agent": "dev"'));
    });
  });
});
