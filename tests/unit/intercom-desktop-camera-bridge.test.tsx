import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntercomDesktopCameraBridge } from '@/components/remote-instances/intercom-desktop-camera-bridge';
import type { IntercomDesktopCameraRequest } from '../../shared/intercom-desktop-camera';

const { hostApiFetchMock, subscribedHandlers } = vi.hoisted(() => ({
  hostApiFetchMock: vi.fn(),
  subscribedHandlers: [] as Array<(payload: IntercomDesktopCameraRequest) => void>,
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (_eventName: string, handler: (payload: IntercomDesktopCameraRequest) => void) => {
    subscribedHandlers.push(handler);
    return vi.fn();
  },
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock('@/pages/Chat/CameraCaptureModal', () => ({
  CameraCaptureModal: (props: {
    open: boolean;
    onClose: () => void;
    onIdentifyPhoto: (file: File) => Promise<void>;
  }) => {
    if (!props.open) {
      return null;
    }
    return (
      <button
        type="button"
        onClick={async () => {
          await props.onIdentifyPhoto(new File(['camera-bytes'], 'camera.jpg', { type: 'image/jpeg' }));
          props.onClose();
        }}
      >
        submit camera
      </button>
    );
  },
}));

describe('IntercomDesktopCameraBridge', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ success: true });
    subscribedHandlers.length = 0;
  });

  it('does not overwrite a completed camera photo with a close/cancel result', async () => {
    render(<IntercomDesktopCameraBridge />);

    await act(async () => {
      subscribedHandlers[0]?.({
        requestId: 'camera-task-1',
        taskId: 'task-1',
        artifactPath: '~/.ktclaw/intercom/outbox/task-1/camera.jpg',
        acceptedPath: '~/.ktclaw/intercom/outbox/task-1/desktop-camera-accepted.json',
        resultPath: '~/.ktclaw/intercom/outbox/task-1/desktop-camera-result.json',
        requestedAt: Date.now(),
      });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'submit camera' }));

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith(
        '/api/intercom/desktop-camera/complete',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith(
      '/api/intercom/desktop-camera/fail',
      expect.anything(),
    );
  });
});
