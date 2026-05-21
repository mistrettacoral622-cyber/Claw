import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRemoteInstancesPanel } from '@/components/settings-center/settings-remote-instances-panel';
import { useRemoteInstancesStore } from '@/stores/remote-instances';
import { toast } from '@/lib/toast';
import type { RemoteInstance } from '@/stores/remote-instances';

const { hostApiFetchMock, clipboardWriteTextMock } = vi.hoisted(() => ({
  hostApiFetchMock: vi.fn(),
  clipboardWriteTextMock: vi.fn(async () => undefined),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
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
    t: (key: string, options?: { count?: number; checkedAt?: string; name?: string }) => {
      const table: Record<string, string> = {
        'remoteInstances.intro.title': 'Remote instance management',
        'remoteInstances.intro.urlFirstTitle': 'Start with an Agent Card URL',
        'remoteInstances.intro.urlFirstDescription':
          'Connect the endpoint first, then fill in auth details only when the target actually needs them.',
        'remoteInstances.intro.authLaterTitle': 'Keep auth editing in the detail view',
        'remoteInstances.intro.authLaterDescription':
          'Bearer tokens and custom headers stay editable after creation so the add flow remains lightweight.',
        'remoteInstances.add.title': 'Add remote instance',
        'remoteInstances.add.agentCardUrlLabel': 'Agent Card URL',
        'remoteInstances.add.agentCardUrlPlaceholder':
          'https://remote.example.com/.well-known/agent-card.json',
        'remoteInstances.add.displayNameLabel': 'Display name',
        'remoteInstances.add.displayNamePlaceholder': 'Optional workspace label',
        'remoteInstances.add.submit': 'Add instance',
        'remoteInstances.add.helper':
          'The initial setup only needs the Agent Card URL. Connection auth can be added from the detail view after creation.',
        'remoteInstances.self.title': 'My remote instance',
        'remoteInstances.self.descriptionTitle': 'Share this KTClaw with other agents',
        'remoteInstances.self.description':
          'Expose this desktop as an inbound A2A endpoint, then give collaborators your Agent Card URL and access header.',
        'remoteInstances.self.enabledLabel': 'Enable inbound',
        'remoteInstances.self.agentCardNameLabel': 'Agent Card name',
        'remoteInstances.self.agentCardNamePlaceholder': 'My KTClaw',
        'remoteInstances.self.agentCardDescriptionLabel': 'Agent Card description',
        'remoteInstances.self.agentCardDescriptionPlaceholder': 'Remote-controlled desktop agent',
        'remoteInstances.self.allowUnauthenticatedLabel': 'Allow unauthenticated inbound',
        'remoteInstances.self.allowUnauthenticatedHint':
          'Use only on trusted private networks. Access keys are safer for shared links.',
        'remoteInstances.self.networkModeLabel': 'Network access',
        'remoteInstances.self.networkModes.local': 'This computer only',
        'remoteInstances.self.networkModes.lan': 'Same Wi-Fi or LAN',
        'remoteInstances.self.networkLocalHint':
          'Keeps Gateway bound to loopback. Other devices cannot connect directly.',
        'remoteInstances.self.networkLanHint':
          'Binds Gateway to LAN. Windows Firewall and the router/network must allow the port.',
        'remoteInstances.self.networkStatusLocal': 'Local only',
        'remoteInstances.self.networkStatusLan': 'LAN enabled',
        'remoteInstances.self.firewallBadge': 'Firewall may prompt',
        'remoteInstances.self.save': 'Save inbound settings',
        'remoteInstances.self.refresh': 'Refresh',
        'remoteInstances.self.myAgentCardUrlTitle': 'My Agent Card URL',
        'remoteInstances.self.myAgentCardUrlDescription':
          'Give this URL to another A2A client. Use the LAN or Tailscale address when they are not on this machine.',
        'remoteInstances.self.statusEnabled': 'Inbound on',
        'remoteInstances.self.statusDisabled': 'Inbound off',
        'remoteInstances.self.localAgentCardUrlLabel': 'Local Agent Card URL',
        'remoteInstances.self.lanAgentCardUrlLabel': 'LAN Agent Card URL',
        'remoteInstances.self.localA2AUrlLabel': 'Local A2A endpoint',
        'remoteInstances.self.copyAgentCardUrl': 'Copy Agent Card URL',
        'remoteInstances.self.copyLanAgentCardUrl': 'Copy LAN Agent Card URL',
        'remoteInstances.self.copyA2AUrl': 'Copy A2A endpoint',
        'remoteInstances.self.lanHintFallback':
          'Use the LAN address when another device is on the same Wi-Fi or wired network.',
        'remoteInstances.self.tailscaleHint':
          'For Tailscale, use your MagicDNS/Serve/Funnel URL and keep /.well-known/agent-card.json plus /a2a reachable.',
        'remoteInstances.self.accessKeysTitle': 'Access keys',
        'remoteInstances.self.accessKeysDescription':
          'Generated keys are shown in full only once. Existing keys stay masked.',
        'remoteInstances.self.newKeyLabel': 'New access key label',
        'remoteInstances.self.newKeyPlaceholder': 'teammate-laptop',
        'remoteInstances.self.generateKey': 'Generate key',
        'remoteInstances.self.newKeyReadyTitle': 'Copy this header now',
        'remoteInstances.self.newKeyReadyDescription':
          'The raw key will not be shown again after this panel is dismissed or refreshed.',
        'remoteInstances.self.dismissKey': 'Dismiss',
        'remoteInstances.self.copyHeader': 'Copy Authorization header',
        'remoteInstances.self.revokeKey': 'Revoke',
        'remoteInstances.self.noKeys':
          'No access keys yet. Generate one before sharing a private endpoint.',
        'remoteInstances.self.toasts.saved': 'Inbound settings saved',
        'remoteInstances.self.toasts.saveFailed': 'Failed to save inbound settings',
        'remoteInstances.self.toasts.keyGenerated': 'Access key generated',
        'remoteInstances.self.toasts.keyGenerateFailed': 'Failed to generate access key',
        'remoteInstances.self.toasts.keyRevoked': 'Access key revoked',
        'remoteInstances.self.toasts.keyRevokeFailed': 'Failed to revoke access key',
        'remoteInstances.self.toasts.copied': 'Copied',
        'remoteInstances.self.toasts.copyFailed': 'Copy failed',
        'remoteInstances.list.title': 'Configured instances',
        'remoteInstances.list.summaryDescription':
          'Select an instance to review its Agent Card, connection status, and auth settings.',
        'remoteInstances.list.refresh': 'Refresh list',
        'remoteInstances.list.loading': 'Loading remote instances...',
        'remoteInstances.list.empty':
          'No remote instances yet. Add an Agent Card URL above to create the first one.',
        'remoteInstances.list.unnamed': 'Unnamed remote instance',
        'remoteInstances.list.statusConnected': 'Connected',
        'remoteInstances.list.statusNeedsAttention': 'Needs attention',
        'remoteInstances.list.statusNotChecked': 'Not checked',
        'remoteInstances.list.test': 'Test',
        'remoteInstances.list.refreshCard': 'Refresh Agent Card',
        'remoteInstances.details.title': 'Instance details',
        'remoteInstances.details.empty':
          'Select a remote instance to edit auth, inspect its Agent Card, and run diagnostics.',
        'remoteInstances.details.noDescription': 'No Agent Card summary is available yet.',
        'remoteInstances.details.displayNameLabel': 'Display name',
        'remoteInstances.details.agentCardUrlLabel': 'Agent Card URL',
        'remoteInstances.details.authModeLabel': 'Authentication mode',
        'remoteInstances.details.bearerTokenLabel': 'Bearer token',
        'remoteInstances.details.bearerTokenPlaceholder':
          'Paste token only if the remote endpoint requires it',
        'remoteInstances.details.authHint':
          'Choose an auth mode to edit bearer tokens or custom headers for this instance.',
        'remoteInstances.details.headersLabel': 'Custom headers',
        'remoteInstances.details.headersPlaceholder':
          'Authorization: Bearer ...\nX-Workspace-Id: demo',
        'remoteInstances.details.save': 'Save changes',
        'remoteInstances.details.test': 'Run connection test',
        'remoteInstances.details.refreshCard': 'Refresh Agent Card',
        'remoteInstances.details.delete': 'Delete',
        'remoteInstances.details.connectionTitle': 'Connection status',
        'remoteInstances.details.connectionEmpty':
          'No connection test has been run yet for this instance.',
        'remoteInstances.details.metadataTitle': 'Metadata',
        'remoteInstances.details.metadataCreated': 'Created',
        'remoteInstances.details.metadataUpdated': 'Updated',
        'remoteInstances.details.agentCardTitle': 'Agent Card summary',
        'remoteInstances.details.capabilitiesEmpty':
          'No capabilities have been published yet.',
        'remoteInstances.details.inputModes': 'Input modes',
        'remoteInstances.details.outputModes': 'Output modes',
        'remoteInstances.details.modesEmpty': 'Not declared',
        'remoteInstances.details.skills': 'Advertised skills',
        'remoteInstances.details.skillsEmpty': 'No skills advertised',
        'remoteInstances.authModes.none': 'No auth',
        'remoteInstances.authModes.bearer': 'Bearer token',
        'remoteInstances.authModes.headers': 'Custom headers',
        'remoteInstances.authModes.mixed': 'Token + headers',
        'remoteInstances.deleteDialog.title': 'Delete remote instance',
        'remoteInstances.deleteDialog.confirm': 'Delete instance',
        'remoteInstances.deleteDialog.cancel': 'Cancel',
        'remoteInstances.toasts.created': 'Remote instance added',
        'remoteInstances.toasts.saved': 'Remote instance updated',
        'remoteInstances.toasts.refreshed': 'Agent Card refreshed',
        'remoteInstances.toasts.testPassed': 'Connection test succeeded',
        'remoteInstances.toasts.testCompleted': 'Connection test completed',
        'remoteInstances.toasts.deleted': 'Remote instance deleted',
      };

      if (key === 'remoteInstances.list.summaryTitle_one' || key === 'remoteInstances.list.summaryTitle_other') {
        return `${options?.count ?? 0} configured instances`;
      }
      if (
        key === 'remoteInstances.list.capabilityCount_one' ||
        key === 'remoteInstances.list.capabilityCount_other'
      ) {
        return `${options?.count ?? 0} capabilities`;
      }
      if (key === 'remoteInstances.details.lastChecked') {
        return `Last checked ${options?.checkedAt ?? ''}`;
      }
      if (key === 'remoteInstances.deleteDialog.message') {
        return `Remove "${options?.name ?? ''}" from this workspace? This only deletes the local KTClaw configuration.`;
      }

      return table[key] ?? key;
    },
    i18n: { language: 'en-US' },
  }),
}));

const BASE_INSTANCE: RemoteInstance = {
  id: 'remote-1',
  displayName: 'Edge Assistant',
  agentCardUrl: 'https://remote.example.com/.well-known/agent-card.json',
  authMode: 'none',
  bearerToken: null,
  headers: {},
  agentCard: {
    name: 'Edge Assistant',
    description: 'Handles remote planning tasks.',
    version: '2026.4.8',
    url: 'https://remote.example.com/.well-known/agent-card.json',
    capabilities: [
      { id: 'chat', label: 'Chat', description: 'Accepts multi-turn messages' },
      { id: 'search', label: 'Search', description: null },
    ],
    skills: ['planner', 'search'],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  },
  lastTest: {
    ok: true,
    status: 'ok',
    message: 'Gateway reachable',
    checkedAt: '2026-05-20T08:00:00.000Z',
  },
  createdAt: '2026-05-20T07:30:00.000Z',
  updatedAt: '2026-05-20T08:00:00.000Z',
};

const BASE_SELF = {
  enabled: true,
  gateway: {
    state: 'running',
    port: 18789,
  },
  network: {
    mode: 'local',
    bindMode: 'loopback',
    tailscaleMode: 'off',
    customBindHost: null,
    externallyReachable: false,
    requiresFirewall: false,
  },
  inbound: {
    agentCard: {
      name: 'My KTClaw',
      description: 'Desktop endpoint',
    },
    allowUnauthenticated: false,
    apiKeys: [
      { label: 'alice', maskedKey: 'ktclaw_a...1234' },
    ],
  },
  urls: {
    localAgentCardUrl: 'http://127.0.0.1:18789/.well-known/agent-card.json',
    localA2AEndpointUrl: 'http://127.0.0.1:18789/a2a',
    lanAgentCardUrl: 'http://192.168.1.20:18789/.well-known/agent-card.json',
    lanA2AEndpointUrl: 'http://192.168.1.20:18789/a2a',
    tailscaleAgentCardUrlHint: 'https://myhost.tailnet.ts.net/.well-known/agent-card.json',
    tailscaleA2AEndpointUrlHint: 'https://myhost.tailnet.ts.net/a2a',
  },
  share: {
    url: 'http://127.0.0.1:18789/.well-known/agent-card.json',
    headerName: 'Authorization',
    headerValueExample: 'Bearer <access-key>',
    headerLineExample: 'Authorization: Bearer <access-key>',
  },
  newAccessKey: null,
  hints: {
    lan: 'Use the LAN URL when the other device is on the same network: http://192.168.1.20:18789',
    tailscale: 'For remote sharing, use a Tailscale MagicDNS/Serve/Funnel URL.',
  },
  reloadRequested: false,
};

function renderPanel() {
  return render(<SettingsRemoteInstancesPanel />);
}

describe('SettingsRemoteInstancesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
    useRemoteInstancesStore.getState().reset();

    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-instances/self' && (!init || init.method === undefined)) {
        return { self: BASE_SELF };
      }

      if (path === '/api/remote-instances/self' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        return {
          self: {
            ...BASE_SELF,
            enabled: body.enabled,
            inbound: {
              ...BASE_SELF.inbound,
              allowUnauthenticated: body.allowUnauthenticated,
              agentCard: {
                name: body.agentCardName,
                description: body.agentCardDescription,
              },
            },
            network: {
              ...BASE_SELF.network,
              mode: body.networkMode ?? BASE_SELF.network.mode,
              bindMode: body.networkMode === 'lan' ? 'lan' : 'loopback',
              externallyReachable: body.networkMode === 'lan',
              requiresFirewall: body.networkMode === 'lan',
            },
            share: {
              ...BASE_SELF.share,
              url: body.networkMode === 'lan'
                ? BASE_SELF.urls.lanAgentCardUrl
                : BASE_SELF.urls.localAgentCardUrl,
            },
            reloadRequested: true,
          },
        };
      }

      if (path === '/api/remote-instances/self/api-keys' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return {
          self: {
            ...BASE_SELF,
            inbound: {
              ...BASE_SELF.inbound,
              apiKeys: [
                ...BASE_SELF.inbound.apiKeys,
                { label: body.label, maskedKey: 'ktclaw_a...9876' },
              ],
            },
            newAccessKey: {
              label: body.label,
              key: 'ktclaw_a2a_generated',
              header: 'Authorization: Bearer ktclaw_a2a_generated',
            },
            reloadRequested: true,
          },
        };
      }

      if (path === '/api/remote-instances/self/api-keys/alice' && init?.method === 'DELETE') {
        return {
          self: {
            ...BASE_SELF,
            inbound: {
              ...BASE_SELF.inbound,
              apiKeys: [],
            },
            reloadRequested: true,
          },
        };
      }

      if (path === '/api/remote-instances' && (!init || init.method === undefined)) {
        return { instances: [BASE_INSTANCE] };
      }

      if (path === '/api/remote-instances' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return {
          instance: {
            ...BASE_INSTANCE,
            id: 'remote-2',
            displayName: body.displayName ?? 'New Remote',
            agentCardUrl: body.agentCardUrl,
            authMode: 'none',
            bearerToken: null,
            headers: {},
            lastTest: null,
            agentCard: {
              ...BASE_INSTANCE.agentCard,
              name: body.displayName ?? 'New Remote',
              url: body.agentCardUrl,
            },
          },
        };
      }

      if (path === '/api/remote-instances/remote-1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        return {
          instance: {
            ...BASE_INSTANCE,
            ...body,
            displayName: body.displayName ?? BASE_INSTANCE.displayName,
            agentCardUrl: body.agentCardUrl ?? BASE_INSTANCE.agentCardUrl,
            bearerToken: body.bearerToken ?? null,
            headers: body.headers ?? {},
          },
        };
      }

      if (path === '/api/remote-instances/remote-1/agent-card/refresh' && init?.method === 'POST') {
        return {
          instance: {
            ...BASE_INSTANCE,
            agentCard: {
              ...BASE_INSTANCE.agentCard,
              capabilities: [
                ...(BASE_INSTANCE.agentCard?.capabilities ?? []),
                { id: 'tools', label: 'Tools', description: 'Exposes task tools' },
              ],
            },
          },
        };
      }

      if (path === '/api/remote-instances/remote-1/test' && init?.method === 'POST') {
        return {
          ok: false,
          status: 'unauthorized',
          message: 'Missing token',
          checkedAt: '2026-05-20T09:00:00.000Z',
        };
      }

      if (path === '/api/remote-instances/remote-1' && init?.method === 'DELETE') {
        return { ok: true };
      }

      throw new Error(`Unexpected host api call: ${path} ${init?.method ?? 'GET'}`);
    });
  });

  it('creates a remote instance from the Agent Card URL first', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Test' });

    fireEvent.change(screen.getAllByLabelText('Agent Card URL')[0] as HTMLElement, {
      target: { value: 'https://new.example.com/card.json' },
    });
    fireEvent.change(screen.getAllByLabelText('Display name')[0] as HTMLElement, {
      target: { value: 'New Remote' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add instance' }));

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/remote-instances',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            agentCardUrl: 'https://new.example.com/card.json',
            displayName: 'New Remote',
          }),
        }),
      );
    });

    expect(await screen.findAllByText('New Remote')).not.toHaveLength(0);
    expect(toast.success).toHaveBeenCalledWith('Remote instance added');
  });

  it('configures the self inbound A2A endpoint and one-time access header', async () => {
    renderPanel();

    expect(await screen.findByText('My Agent Card URL')).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:18789/.well-known/agent-card.json')).toBeInTheDocument();
    expect(screen.getByText('Local only')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Agent Card name'), {
      target: { value: 'Shared Desktop' },
    });
    fireEvent.change(screen.getByLabelText('Agent Card description'), {
      target: { value: 'Remote control endpoint' },
    });
    fireEvent.change(screen.getByLabelText('Network access'), {
      target: { value: 'lan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save inbound settings' }));

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/remote-instances/self',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            enabled: true,
            agentCardName: 'Shared Desktop',
            agentCardDescription: 'Remote control endpoint',
            allowUnauthenticated: false,
            networkMode: 'lan',
          }),
        }),
      );
    });
    expect(toast.success).toHaveBeenCalledWith('Inbound settings saved');
    expect(await screen.findByText('LAN enabled')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New access key label'), {
      target: { value: 'bob-laptop' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }));

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/remote-instances/self/api-keys',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ label: 'bob-laptop' }),
        }),
      );
    });
    expect(await screen.findByText('Authorization: Bearer ktclaw_a2a_generated')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy Authorization header' }));
    await waitFor(() => {
      expect(clipboardWriteTextMock).toHaveBeenCalledWith('Authorization: Bearer ktclaw_a2a_generated');
    });
  });

  it('revokes self inbound A2A access keys from the settings block', async () => {
    renderPanel();

    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/remote-instances/self/api-keys/alice',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByText('No access keys yet. Generate one before sharing a private endpoint.')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Access key revoked');
  });

  it('saves auth settings from the detail view after creation', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Save changes' });

    fireEvent.change(screen.getAllByLabelText('Authentication mode')[0] as HTMLElement, {
      target: { value: 'mixed' },
    });
    fireEvent.change(screen.getByLabelText('Bearer token'), {
      target: { value: 'secret-token' },
    });
    fireEvent.change(screen.getByLabelText('Custom headers'), {
      target: { value: 'X-Workspace-Id: remote-a\nX-Trace: abc123' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/remote-instances/remote-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            displayName: 'Edge Assistant',
            agentCardUrl: 'https://remote.example.com/.well-known/agent-card.json',
            authMode: 'mixed',
            bearerToken: 'secret-token',
            headers: {
              'X-Workspace-Id': 'remote-a',
              'X-Trace': 'abc123',
            },
          }),
        }),
      );
    });

    expect(toast.success).toHaveBeenCalledWith('Remote instance updated');
  });

  it('runs connection tests and refreshes the Agent Card from the selected instance', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Run connection test' });

    fireEvent.click(screen.getByRole('button', { name: 'Run connection test' }));

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/remote-instances/remote-1/test',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(await screen.findByText('unauthorized')).toBeInTheDocument();
    expect(screen.getByText('Missing token')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh Agent Card' })[1] as HTMLElement);

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/remote-instances/remote-1/agent-card/refresh',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    expect(await screen.findByText('Tools')).toBeInTheDocument();
  });

  it('deletes a remote instance only after explicit confirmation', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Delete' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Remove "Edge Assistant" from this workspace/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete instance' }));

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/remote-instances/remote-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('Edge Assistant')).not.toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith('Remote instance deleted');
  });
});
