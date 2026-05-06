import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatMessage } from '@/pages/Chat/ChatMessage';

const settingsState = {
  showToolCalls: false,
};

const chatState = {
  acceptCameraRequest: vi.fn(),
  declineCameraRequest: vi.fn(),
};

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
}));

describe('generated image chat message', () => {
  it('renders the pending generation card', () => {
    render(
      <ChatMessage
        message={{
          role: 'assistant',
          content: '',
          _imageGenerationPending: { prompt: '一只橘猫' },
        }}
        showThinking={false}
      />,
    );

    expect(screen.getByText('正在生成图片')).toBeInTheDocument();
    expect(screen.getByText('一只橘猫')).toBeInTheDocument();
  });

  it('renders the generated image card and lightbox metadata', () => {
    render(
      <ChatMessage
        message={{
          role: 'assistant',
          content: '',
          _generatedImages: [{
            filePath: 'C:/Users/22688/.openclaw/media/generated/cat.png',
            mimeType: 'image/png',
            preview: 'data:image/png;base64,Y2F0',
            provider: 'dashscope',
            model: 'wan2.6-t2i',
            prompt: '一只橘猫',
            size: '1280*1280',
          }],
        }}
        showThinking={false}
      />,
    );

    expect(screen.getByText('DashScope / wan2.6-t2i / 1280*1280')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Preview cat\.png/i }));
    expect(screen.getByTitle('关闭图片预览')).toBeInTheDocument();
  });

  it('renders the camera request consent card', () => {
    render(
      <ChatMessage
        message={{
          role: 'assistant',
          content: '',
          _cameraRequest: {
            id: 'req-1',
            sessionKey: 'agent:main:main',
            requestedAt: Date.now(),
            status: 'pending',
          },
        }}
        showThinking={false}
      />,
    );

    expect(screen.getByText('Agent 请求你拍一张照片')).toBeInTheDocument();
    expect(screen.getByText('打开摄像头')).toBeInTheDocument();
    expect(screen.getByText('暂不拍照')).toBeInTheDocument();
  });
});
