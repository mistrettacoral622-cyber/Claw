import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';

const {
  agentsState,
  chatState,
  settingsState,
  providerStoreState,
  navigateMock,
  hostApiFetchMock,
  generateImageMock,
} = vi.hoisted(() => ({
  agentsState: { agents: [] as Array<Record<string, unknown>> },
  chatState: {
    currentAgentId: 'main',
    currentSessionKey: 'agent:main:main',
    messages: [] as Array<Record<string, unknown>>,
    newSession: vi.fn(),
    generateImage: vi.fn(),
  },
  settingsState: { defaultModel: 'claude-sonnet-4-6' },
  providerStoreState: {
    accounts: [] as Array<Record<string, unknown>>,
    vendors: [] as Array<Record<string, unknown>>,
    refreshProviderSnapshot: vi.fn(async () => undefined),
  },
  navigateMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  generateImageMock: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: (selector: (state: typeof providerStoreState) => unknown) => selector(providerStoreState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ChatInput image command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    chatState.generateImage = generateImageMock;
  });

  it('runs /image prompt through generateImage without calling normal onSend', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/image 一只橘猫' } });
    fireEvent.click(screen.getByTitle('发送'));

    expect(generateImageMock).toHaveBeenCalledWith('一只橘猫');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows inline validation for /image without a prompt', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/image' } });
    fireEvent.click(screen.getByTitle('发送'));

    expect(screen.getByText('请输入图片提示词，例如 /image 一只橘猫坐在键盘旁边')).toBeInTheDocument();
    expect(generateImageMock).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('helper button inserts /image when composer is empty', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    fireEvent.click(screen.getByTitle('生成图片'));

    expect(screen.getByRole('textbox')).toHaveValue('/image ');
    expect(generateImageMock).not.toHaveBeenCalled();
  });
});
