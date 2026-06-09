import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteInstances } from '@/pages/RemoteInstances';
import { useIntercomStore } from '@/stores/intercom';
import { hostApiFetch } from '@/lib/host-api';

const invokeIpcMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
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
        'remoteInstances.intercom.consoleDescription': 'Pick a configured remote KTClaw and send commands.',
        'remoteInstances.intercom.refresh': 'Refresh',
        'remoteInstances.intercom.installProtocol': 'Install SOP',
        'remoteInstances.intercom.instanceListTitle': 'Instances',
        'remoteInstances.intercom.instanceCount': `${options?.count ?? 0} instances`,
        'remoteInstances.intercom.emptyRoutes': 'No Intercom routes yet',
        'remoteInstances.intercom.newRoute': 'New',
        'remoteInstances.intercom.configureTitle': 'Instance configuration',
        'remoteInstances.intercom.configureRoute': 'Configure route',
        'remoteInstances.intercom.configSheetDescription': 'Edit the SSH route used to reach this remote KTClaw instance.',
        'remoteInstances.intercom.pasteConnectionInfoTitle': 'Connect from copied info',
        'remoteInstances.intercom.pasteConnectionInfoDescription': 'Paste copied connection info here.',
        'remoteInstances.intercom.pasteConnectionInfo': 'Paste connection info',
        'remoteInstances.intercom.routeReady': 'Route saved',
        'remoteInstances.intercom.unsavedRoute': 'Unsaved route',
        'remoteInstances.intercom.hostLabel': 'Host',
        'remoteInstances.intercom.sshUserLabel': 'SSH user',
        'remoteInstances.intercom.sshPortLabel': 'SSH port',
        'remoteInstances.intercom.sshPasswordLabel': 'SSH password',
        'remoteInstances.intercom.passwordSavedPlaceholder': 'Password saved',
        'remoteInstances.intercom.passwordSavedHint': 'Leave blank to keep the saved password.',
        'remoteInstances.intercom.passwordOptionalHint': 'Optional password login.',
        'remoteInstances.intercom.clearPassword': 'Clear password',
        'remoteInstances.intercom.showAdvancedConfig': 'Show advanced options',
        'remoteInstances.intercom.hideAdvancedConfig': 'Hide advanced options',
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
        'remoteInstances.intercom.remoteDispatching': 'Connecting to the remote KTClaw Gateway...',
        'remoteInstances.intercom.remoteGeneratingReply': 'Remote KTClaw received the message and is generating a reply...',
        'remoteInstances.intercom.remoteStillRunning': 'Remote KTClaw is still working.',
        'remoteInstances.intercom.noAssistantReply': 'The remote command completed, but no assistant text has been returned yet.',
        'remoteInstances.intercom.remoteTaskLabel': 'Remote task',
        'remoteInstances.intercom.attachFiles': 'Attach files',
        'remoteInstances.intercom.sendTask': 'Send task',
        'remoteInstances.intercom.screenshot': 'Screenshot',
        'remoteInstances.intercom.removeAttachment': 'Remove attachment',
        'remoteInstances.intercom.taskResultLabel': 'task result',
        'remoteInstances.intercom.transferDetailsLabel': 'transfers',
        'remoteInstances.intercom.screenshotTaskPrompt': 'Capture a screenshot on the remote machine and return it as an image artifact.',
        'remoteInstances.intercom.send': 'Send',
        'remoteInstances.intercom.toasts.fileStageFailed': 'Failed to stage files',
        'remoteInstances.intercom.toasts.taskDelivered': 'Remote task completed',
        'remoteInstances.intercom.toasts.taskFailed': 'Failed to run remote task',
        'remoteInstances.intercom.toasts.artifactDownloadFailed': 'Failed to download remote artifacts',
        'remoteInstances.intercom.toasts.connectionInfoPasted': 'Connection info pasted',
        'remoteInstances.intercom.toasts.connectionInfoPasteFailed': 'Invalid connection info',
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
    invokeIpcMock.mockReset();
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
    expect(screen.getByLabelText('Remote host')).toHaveValue('10.101.208.178');
    expect(screen.getByLabelText('SSH password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password saved')).toBeInTheDocument();
    expect(screen.queryByLabelText('SSH port')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Intercom session')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remote OpenClaw command')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show advanced options' }));

    expect(screen.getByLabelText('SSH port')).toHaveValue('22');
    expect(screen.getByLabelText('Intercom session')).toHaveValue('intercom');
    expect(screen.getByLabelText('Remote OpenClaw command')).toHaveValue('openclaw');
  });

  it('saves a new route from minimal connection fields', async () => {
    vi.mocked(hostApiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/intercom' && (!init || init.method === undefined)) {
        return { ...READY_INTERCOM_RESPONSE, routes: [] };
      }
      if (path === '/api/intercom/routes' && init?.method === 'POST') {
        return READY_INTERCOM_RESPONSE;
      }
      return READY_INTERCOM_RESPONSE;
    });

    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByLabelText('Route ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Intercom session')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remote OpenClaw command')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Remote host'), {
      target: { value: '10.101.208.178' },
    });
    fireEvent.change(screen.getByLabelText('SSH user'), {
      target: { value: 'sunyb9' },
    });
    fireEvent.change(screen.getByLabelText('SSH password'), {
      target: { value: 'secret' },
    });
    fireEvent.change(screen.getByLabelText('Remote agent id'), {
      target: { value: 'main' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save route' }));

    expect(hostApiFetch).toHaveBeenCalledWith(
      '/api/intercom/routes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          id: '10.101.208.178-main',
          displayName: '10.101.208.178 / main',
          host: '10.101.208.178',
          agent: 'main',
          transport: 'ssh',
          sessionId: 'intercom',
          enabled: true,
          sshUser: 'sunyb9',
          sshPort: 22,
          sshPassword: 'secret',
          clearSshPassword: false,
          remoteCommand: 'openclaw',
          remoteGatewayPort: 18789,
        }),
      }),
    );
  });

  it('pastes copied connection info into a new route', async () => {
    const clipboardReadText = vi.fn(async () => JSON.stringify({
      type: 'ktclaw-intercom-route',
      version: 1,
      routeId: 'windows-dev-main',
      displayName: 'Windows Dev / main',
      host: '192.168.0.111',
      sshUser: '22688',
      sshPort: 22,
      agent: 'main',
      sessionId: 'intercom',
      remoteCommand: 'openclaw',
      remoteGatewayPort: 24567,
    }));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: clipboardReadText },
    });

    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Paste connection info' }));

    expect(await screen.findByDisplayValue('192.168.0.111')).toBeInTheDocument();
    expect(screen.getByLabelText('Remote host')).toHaveValue('192.168.0.111');
    expect(screen.getByLabelText('SSH user')).toHaveValue('22688');
    expect(screen.getByLabelText('Remote agent id')).toHaveValue('main');
  });
});
