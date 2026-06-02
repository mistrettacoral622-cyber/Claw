import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        'remoteInstances.intercom.sshPasswordLabel': 'SSH password',
        'remoteInstances.intercom.passwordSavedPlaceholder': 'Password saved',
        'remoteInstances.intercom.passwordSavedHint': 'Leave blank to keep the saved password.',
        'remoteInstances.intercom.passwordOptionalHint': 'Optional password login.',
        'remoteInstances.intercom.clearPassword': 'Clear password',
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
        'remoteInstances.intercom.remoteTaskLabel': 'Remote task',
        'remoteInstances.intercom.attachFiles': 'Attach files',
        'remoteInstances.intercom.sendTask': 'Send task',
        'remoteInstances.intercom.screenshot': 'Screenshot',
        'remoteInstances.intercom.camera': 'Camera',
        'remoteInstances.intercom.removeAttachment': 'Remove attachment',
        'remoteInstances.intercom.taskResultLabel': 'task result',
        'remoteInstances.intercom.transferDetailsLabel': 'transfers',
        'remoteInstances.intercom.screenshotTaskPrompt': 'Capture a screenshot on the remote machine and return it as an image artifact.',
        'remoteInstances.intercom.cameraTaskPrompt': 'Ask the remote KTClaw desktop client to take a camera photo and return it as an image artifact.',
        'remoteInstances.intercom.send': 'Send',
        'remoteInstances.intercom.toasts.messageQueued': 'Message sent to Linux',
        'remoteInstances.intercom.toasts.messageDelivered': `Message delivered (${options?.code ?? 0})`,
        'remoteInstances.intercom.toasts.messageFailed': 'Failed to send message',
        'remoteInstances.intercom.toasts.fileStageFailed': 'Failed to stage files',
        'remoteInstances.intercom.toasts.taskDelivered': 'Remote task completed',
        'remoteInstances.intercom.toasts.taskFailed': 'Failed to run remote task',
        'remoteInstances.intercom.toasts.artifactDownloadFailed': 'Failed to download remote artifacts',
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

let remoteStdout = JSON.stringify({
  content: [
    {
      text: 'Remote agent received the plan.',
      mediaUrl: null,
    },
  ],
});
let remoteStderr = '';

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
    invokeIpcMock.mockReset();
    resetIntercomStore();
    remoteStdout = JSON.stringify({
      content: [
        {
          text: 'Remote agent received the plan.',
          mediaUrl: null,
        },
      ],
    });
    remoteStderr = '';
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
          stdout: remoteStdout,
          stderr: remoteStderr,
          durationMs: 123,
        };
      }
      if (path === '/api/files/stage-paths' && init?.method === 'POST') {
        return [
          {
            id: 'file-1',
            fileName: 'context.md',
            mimeType: 'text/markdown',
            fileSize: 123,
            stagedPath: 'C:/tmp/context.md',
            preview: null,
          },
        ];
      }
      if (path === '/api/intercom/transfers/upload' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return {
          success: true,
          taskId: body.taskId,
          transfers: [
            {
              id: 'upload-1',
              routeId: 'linux-ktclaw',
              taskId: body.taskId,
              direction: 'upload',
              status: 'success',
              fileName: 'context.md',
              localPath: 'C:/tmp/context.md',
              remotePath: `~/.ktclaw/intercom/inbox/dev/${body.taskId}/context.md`,
              mimeType: 'text/markdown',
              size: 123,
              durationMs: 10,
              error: null,
            },
          ],
        };
      }
      if (path === '/api/intercom/tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
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
          stdout: JSON.stringify({
            success: true,
            summary: 'Remote task summary',
            artifacts: [
              { type: 'image', path: '~/.ktclaw/intercom/outbox/task-1/screen.png', name: 'screen.png', mimeType: 'image/png' },
            ],
            logs: 'task logs',
            error: null,
          }),
          stderr: '',
          durationMs: 123,
          taskId: body.taskId,
          task: {
            type: 'remote_task',
            taskId: body.taskId,
            action: body.action,
            payload: body.payload,
            return: body.return,
          },
          result: {
            success: true,
            summary: 'Remote task summary',
            artifacts: [
              { type: 'image', path: '~/.ktclaw/intercom/outbox/task-1/screen.png', name: 'screen.png', mimeType: 'image/png' },
            ],
            logs: 'task logs',
            error: null,
          },
        };
      }
      if (path === '/api/intercom/transfers/download' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return {
          success: true,
          taskId: body.taskId,
          transfers: [
            {
              id: 'download-1',
              routeId: 'linux-ktclaw',
              taskId: body.taskId,
              direction: 'download',
              status: 'success',
              fileName: 'screen.png',
              localPath: '/tmp/screen.png',
              remotePath: '~/.ktclaw/intercom/outbox/task-1/screen.png',
              mimeType: 'image/png',
              size: 100,
              durationMs: 10,
              error: null,
            },
          ],
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
    expect(await screen.findByText('Plan the next step')).toBeInTheDocument();
    expect(screen.getByText('Remote agent received the plan.')).toBeInTheDocument();
    expect(screen.queryByText(/Command completed with exit code/)).not.toBeInTheDocument();
    expect(screen.getByText(/Exit code: 0/)).toBeInTheDocument();
    expect(screen.queryByText('A2A context is preserved for follow-up turns')).not.toBeInTheDocument();
  });

  it('renders returned OpenClaw messages with the normal chat bubble renderer', async () => {
    remoteStdout = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              text: '我是 **KTClaw**，Linux 侧已经收到。'
            },
          ],
        },
      ],
      meta: { durationMs: 15744 },
    });

    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Intercom message'), {
      target: { value: '测试 Linux ktclaw 回复' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('测试 Linux ktclaw 回复')).toBeInTheDocument();
    expect(screen.getByText(/我是/)).toBeInTheDocument();
    expect(screen.queryByText(/"messages"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Command completed with exit code/)).not.toBeInTheDocument();
  });

  it('renders text from noisy OpenClaw stdout content arrays', async () => {
    remoteStdout = [
      '[plugins] [a2a] Registered 6 outbound tools for 1 agent(s)',
      JSON.stringify({
        content: [
          {
            text: '你好！😊\n\n感觉你一直在试探我，又不急着让我干活的节奏。没问题，我随时在。',
            mediaUrl: null,
          },
        ],
        meta: {
          durationMs: 73751,
          agentMeta: { id: 'main' },
        },
      }),
      '[plugins] [a2a] Plugin registered successfully',
    ].join('\n');

    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Intercom message'), {
      target: { value: '你好啊' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('你好啊')).toBeInTheDocument();
    expect(screen.getByText(/感觉你一直在试探我/)).toBeInTheDocument();
    expect(screen.queryByText(/Command completed with exit code/)).not.toBeInTheDocument();
  });

  it('renders OpenClaw JSON written to stderr as a normal assistant bubble', async () => {
    remoteStdout = '';
    remoteStderr = JSON.stringify({
      payloads: [
        {
          text: '今天是 **2026年4月21日**，星期二。',
          mediaUrl: null,
        },
      ],
      meta: {
        durationMs: 51364,
      },
    });

    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Intercom message'), {
      target: { value: 'hello, 今天什么日期' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('hello, 今天什么日期')).toBeInTheDocument();
    expect(screen.getByText(/今天是/)).toBeInTheDocument();
    expect(screen.queryByText(/"payloads"/)).not.toBeInTheDocument();
  });

  it('sends a structured remote task and renders downloaded artifacts', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['C:/tmp/context.md'],
    });
    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send task' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    expect(await screen.findByText('context.md')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Intercom message'), {
      target: { value: 'Inspect the uploaded context' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith(
        '/api/intercom/transfers/upload',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"fileName":"context.md"'),
        }),
      );
      expect(hostApiFetch).toHaveBeenCalledWith(
        '/api/intercom/tasks',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"action":"remote_task"'),
        }),
      );
    });
    expect(await screen.findByText('Remote task summary')).toBeInTheDocument();
    expect(screen.getByText('screen.png')).toBeInTheDocument();
  });

  it('sends screenshot as a remote task action', async () => {
    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));

    await waitFor(() => {
      const taskCall = vi.mocked(hostApiFetch).mock.calls.find(([path]) => path === '/api/intercom/tasks');
      expect(taskCall).toBeTruthy();
      expect(String(taskCall?.[1]?.body)).toContain('"action":"screenshot"');
      expect(String(taskCall?.[1]?.body)).toContain('"format":"png"');
    });
  });

  it('sends camera as a desktop-client-first remote task action', async () => {
    renderPage();

    expect(await screen.findByText('Remote instance control')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Camera' }));

    await waitFor(() => {
      const taskCall = vi.mocked(hostApiFetch).mock.calls.find(([path]) => path === '/api/intercom/tasks');
      expect(taskCall).toBeTruthy();
      expect(String(taskCall?.[1]?.body)).toContain('"action":"camera"');
      expect(String(taskCall?.[1]?.body)).toContain('"format":"jpg"');
    });
  });
});
