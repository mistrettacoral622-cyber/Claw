import { render, screen } from '@testing-library/react';
import { Route, Routes, MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from '@/pages/Settings';
import { hostApiFetch } from '@/lib/host-api';

const { gatewayState, updateState, skillsState, invokeIpcMock } = vi.hoisted(() => ({
  gatewayState: {
    status: { state: 'running', port: 18789 },
    restart: vi.fn(),
  },
  updateState: {
    currentVersion: '1.0.0',
    status: 'idle',
    updateInfo: null,
    progress: null,
    error: null,
    policy: {
      channel: 'stable',
      attemptCount: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastCheckReason: null,
      lastCheckError: null,
      lastCheckChannel: 'stable',
      nextEligibleAt: null,
      rolloutDelayMs: 0,
      checkIntervalMs: 12 * 60 * 60 * 1000,
    },
    setAutoDownload: vi.fn(),
    setChannel: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
    init: vi.fn(),
  },
  skillsState: {
    skills: [
      {
        id: 'skill-a',
        slug: 'skill-a',
        name: 'Skill A',
        description: 'Global skill',
        enabled: false,
        version: '1.0.0',
      },
    ],
    loading: false,
    fetchSkills: vi.fn(async () => {}),
    enableSkill: vi.fn(async () => {}),
    disableSkill: vi.fn(async () => {}),
  },
  invokeIpcMock: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: () => gatewayState,
}));

vi.mock('@/stores/update', () => ({
  useUpdateStore: (selector: (state: typeof updateState) => unknown) => selector(updateState),
}));

vi.mock('@/stores/skills', () => ({
  useSkillsStore: () => skillsState,
}));

vi.mock('@/components/settings/ProvidersSettings', () => ({
  ProvidersSettings: () => <div>Providers Settings Mock</div>,
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: invokeIpcMock,
  toUserMessage: (error: unknown) => String(error),
  getGatewayWsDiagnosticEnabled: () => false,
  setGatewayWsDiagnosticEnabled: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('@/lib/telemetry', () => ({
  clearUiTelemetry: vi.fn(),
  getUiTelemetrySnapshot: vi.fn(() => []),
  subscribeUiTelemetry: vi.fn(() => () => undefined),
  trackUiEvent: vi.fn(),
}));

vi.mock('sonner', () => ({
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
    t: (key: string, options?: string | { defaultValue?: string; [key: string]: unknown }) => {
      if (typeof options === 'string') {
        return options;
      }
      return options?.defaultValue ?? key;
    },
  }),
}));

function renderSettingsAt(section: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings?section=${section}`]}>
      <Routes>
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Settings shell integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hostApiFetch).mockImplementation(async (path) => {
      if (path === '/api/agents') {
        return {
          agents: [
            { id: 'researcher', name: 'Researcher', avatar: 'data:image/png;base64,existing' },
          ],
        };
      }
      if (path === '/api/remote-instances') {
        return { instances: [] };
      }
      if (path === '/api/remote-instances/self') {
        return {
          self: {
            enabled: false,
            gateway: { state: 'running', port: 18789 },
            inbound: {
              agentCard: {},
              allowUnauthenticated: false,
              apiKeys: [],
            },
            urls: {
              localAgentCardUrl: 'http://127.0.0.1:18789/.well-known/agent-card.json',
              localA2AEndpointUrl: 'http://127.0.0.1:18789/a2a',
              lanAgentCardUrl: null,
              lanA2AEndpointUrl: null,
              tailscaleAgentCardUrlHint: 'https://<your-tailnet-host>/.well-known/agent-card.json',
              tailscaleA2AEndpointUrlHint: 'https://<your-tailnet-host>/a2a',
            },
            share: {
              url: 'http://127.0.0.1:18789/.well-known/agent-card.json',
              headerName: 'Authorization',
              headerValueExample: 'Bearer <access-key>',
              headerLineExample: 'Authorization: Bearer <access-key>',
            },
            newAccessKey: null,
            hints: {
              lan: null,
              tailscale: null,
            },
            reloadRequested: false,
          },
        };
      }
      if (path === '/api/usage/recent-token-history?limit=200') {
        return [
          {
            timestamp: '2026-03-23T12:34:00Z',
            sessionId: 'session-1',
            agentId: 'planner-agent',
            model: 'gpt-5.2',
            provider: 'openai',
            inputTokens: 1200,
            outputTokens: 800,
            cacheReadTokens: 100,
            cacheWriteTokens: 50,
            totalTokens: 2150,
            costUsd: 0.1234,
          },
        ];
      }
      if (path === '/api/costs/summary?days=30') {
        return {
          timeline: [],
          totals: {
            inputTokens: 1500,
            outputTokens: 900,
            cacheTokens: 100,
            totalTokens: 2500,
            costUsd: 1.2345,
            sessions: 12,
          },
        };
      }
      if (path === '/api/costs/by-agent' || path === '/api/costs/by-model' || path === '/api/costs/by-cron') {
        return [];
      }
      if (path === '/api/costs/analysis') {
        return {
          optimizationScore: 74,
          cacheSavings: { cacheTokens: 340, estimatedCostUsd: 0.21, savingsRatePct: 12.6 },
          weekOverWeek: {
            previous: { totalTokens: 2000, costUsd: 0.9, sessions: 7, cacheTokens: 180 },
            current: { totalTokens: 2600, costUsd: 1.1, sessions: 9, cacheTokens: 240 },
            deltas: { totalTokensPct: 30, costUsdPct: 22.2, sessionsPct: 28.6, cacheTokensPct: 33.3 },
          },
          anomalies: [],
          insights: [],
        };
      }
      return {};
    });
  });

  it.each([
    ['costs-usage', async () => expect(await screen.findByText('planner-agent')).toBeInTheDocument()],
    ['models-providers', async () => expect(await screen.findByText('Providers Settings Mock')).toBeInTheDocument()],
    ['general', async () => expect(await screen.findByLabelText('工作台名称')).toBeInTheDocument()],
    ['skills-mcp', async () => expect(await screen.findByText('全局 Skills 与 MCP 中心')).toBeInTheDocument()],
    ['tool-permissions', async () => expect(await screen.findByText('工具权限')).toBeInTheDocument()],
    ['remote-instances', async () => expect(await screen.findByLabelText('remoteInstances.add.agentCardUrlLabel')).toBeInTheDocument()],
    ['memory-knowledge', async () => expect(await screen.findByRole('tab', { name: 'memoryKnowledge.tabs.strategy' })).toBeInTheDocument()],
    ['migration-backup', async () => expect(await screen.findByRole('button', { name: '立即创建备份' })).toBeInTheDocument()],
    ['app-updates', async () => expect(await screen.findByRole('combobox', { name: '更新渠道' })).toBeInTheDocument()],
    ['about', async () => expect(await screen.findByRole('heading', { name: 'KTClaw' })).toBeInTheDocument()],
  ] as const)('renders the %s section through a real panel surface', async (_section, assertPanel) => {
    renderSettingsAt(_section);
    await assertPanel();
  });

  it('includes dark-theme aware classes on the settings shell', async () => {
    renderSettingsAt('general');

    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(nav.className).toContain('dark:bg-card/60');
    expect(nav.className).toContain('dark:border-white/10');

    const main = document.querySelector('main');
    expect(main?.className).toContain('dark:bg-background');
  });
});
