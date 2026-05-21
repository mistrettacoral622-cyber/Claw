import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostApiFetch } from '@/lib/host-api';
import { useRemoteInstancesStore } from '@/stores/remote-instances';

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

function storageMock() {
  let values: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete values[key];
    }),
    clear: vi.fn(() => {
      values = {};
    }),
  };
}

describe('remote instances store conversation flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'localStorage', {
      value: storageMock(),
      configurable: true,
    });
    useRemoteInstancesStore.getState().reset();
  });

  it('sends through Host API and stores context_id/task_id for follow-up turns', async () => {
    vi.mocked(hostApiFetch)
      .mockResolvedValueOnce({
        conversation: {
          context_id: 'ctx-1',
          task_id: 'task-1',
        },
        message: {
          role: 'assistant',
          content: 'First reply',
        },
      })
      .mockResolvedValueOnce({
        conversation: {
          context_id: 'ctx-1',
          task_id: 'task-1',
        },
        message: {
          role: 'assistant',
          content: 'Follow-up reply',
        },
      });

    await useRemoteInstancesStore.getState().sendRemoteMessage('remote-1', {
      message: 'Hello remote',
    });
    await useRemoteInstancesStore.getState().sendRemoteMessage('remote-1', {
      message: 'Continue',
    });

    expect(hostApiFetch).toHaveBeenNthCalledWith(
      1,
      '/api/remote-instances/remote-1/conversation/messages',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"message":"Hello remote"'),
      }),
    );
    expect(hostApiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/remote-instances/remote-1/conversation/messages',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"context_id":"ctx-1"'),
      }),
    );

    const thread = useRemoteInstancesStore.getState().threadsByInstanceId['remote-1'];
    expect(thread.contextId).toBe('ctx-1');
    expect(thread.taskId).toBe('task-1');
    expect(thread.messages.map((message) => message.content)).toEqual([
      'Hello remote',
      'First reply',
      'Continue',
      'Follow-up reply',
    ]);
  });

  it('marks optimistic user messages as errors when the Host API send fails', async () => {
    vi.mocked(hostApiFetch).mockRejectedValueOnce(new Error('network down'));

    await expect(
      useRemoteInstancesStore.getState().sendRemoteMessage('remote-1', {
        message: 'Are you there?',
      }),
    ).rejects.toThrow('network down');

    const thread = useRemoteInstancesStore.getState().threadsByInstanceId['remote-1'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({
      content: 'Are you there?',
      status: 'error',
      error: 'network down',
    });
    expect(useRemoteInstancesStore.getState().busyById['remote-1']?.sending).toBeUndefined();
  });
});
