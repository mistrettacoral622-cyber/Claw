import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { CAMERA_REQUEST_ACCEPTED_UI_EVENT } from '../../shared/camera-request';

const {
  agentsState,
  chatState,
  settingsState,
  providerStoreState,
  hostApiFetchMock,
  getUserMediaMock,
  navigateMock,
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
  hostApiFetchMock: vi.fn(),
  getUserMediaMock: vi.fn(),
  navigateMock: vi.fn(),
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

describe('ChatInput camera capture', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const track = { stop: vi.fn() };
    const stream = {
      getTracks: () => [track],
    };
    getUserMediaMock.mockResolvedValue(stream);
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn(() => ({ drawImage: vi.fn() })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
      configurable: true,
      value: vi.fn((callback: BlobCallback) => callback(new Blob(['camera'], { type: 'image/jpeg' }))),
    });
    hostApiFetchMock.mockResolvedValue({
      id: 'staged-image',
      fileName: 'camera-capture.jpg',
      mimeType: 'image/jpeg',
      fileSize: 123,
      stagedPath: 'C:/Users/22688/.openclaw/media/outbound/camera-capture.jpg',
      preview: 'data:image/jpeg;base64,Y2FtZXJh',
    });
  });

  it('opens the camera request modal and waits for explicit camera start', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    fireEvent.click(screen.getByTitle('拍照'));
    expect(screen.getByText('继续打开摄像头')).toBeInTheDocument();
    expect(getUserMediaMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('继续打开摄像头'));
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalledWith({ video: true, audio: false }));
  });

  it('captures and identifies a photo through staged media', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    fireEvent.click(screen.getByTitle('拍照'));
    fireEvent.click(screen.getByText('继续打开摄像头'));
    await waitFor(() => expect(getUserMediaMock).toHaveBeenCalled());

    fireEvent.click(screen.getAllByRole('button', { name: '拍照' }).at(-1)!);
    const identifyButton = await screen.findByText('拍照并识别');
    expect(screen.queryByText('继续打开摄像头')).not.toBeInTheDocument();
    fireEvent.click(identifyButton);

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/files/stage-buffer',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(onSend).toHaveBeenCalledWith(
      '请识别这张图片里的主要内容，并用中文告诉我你看到了什么。',
      expect.any(Array),
      null,
      null,
    );
  });

  it('opens camera UI only after the accepted camera request event', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(CAMERA_REQUEST_ACCEPTED_UI_EVENT, {
        detail: {
          id: 'req-1',
          sessionKey: 'agent:main:main',
          requestedAt: Date.now(),
          status: 'accepted',
        },
      }));
    });

    expect(await screen.findByText('继续打开摄像头')).toBeInTheDocument();
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });
});
