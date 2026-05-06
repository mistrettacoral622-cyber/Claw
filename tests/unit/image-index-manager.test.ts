/**
 * Unit tests for ImageIndexManager
 *
 * Tests the manager state machine, Worker lifecycle, crash recovery, and
 * dimension mismatch detection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock electron runtime (logger uses app.getPath)
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/ktclaw-test'),
    getAppPath: vi.fn(() => '/tmp/ktclaw-test'),
    isPackaged: false,
  },
}));

// Mock logger to avoid file I/O during tests
vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Worker Mock ──────────────────────────────────────────────────────────────
// Track created mock worker instances
const workerInstances: Array<{
  terminate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  _handlers: Map<string, ((...args: unknown[]) => void)[]>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}> = [];

function createMockWorker() {
  const _handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const worker = {
    terminate: vi.fn().mockResolvedValue(0),
    postMessage: vi.fn(),
    _handlers,
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!_handlers.has(event)) _handlers.set(event, []);
      _handlers.get(event)!.push(handler);
    },
    emit(event: string, ...args: unknown[]) {
      for (const h of _handlers.get(event) ?? []) h(...args);
    },
  };
  workerInstances.push(worker);
  return worker;
}

// Create the constructor mock using vi.fn() at module level
// This is hoisted via the vi.mock factory pattern
vi.mock('node:worker_threads', async () => {
  const { vi: viInner } = await import('vitest');
  const WorkerMock = viInner.fn(function () {
    return createMockWorker();
  });
  // Make it a proper constructor mock
  Object.setPrototypeOf(WorkerMock, Function);
  return {
    Worker: WorkerMock,
    workerData: null,
    parentPort: null,
  };
});

// ─── VectorStore Mock ─────────────────────────────────────────────────────────

type MockVectorStore = {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  upsertBatch: ReturnType<typeof vi.fn>;
  getAllEntries: ReturnType<typeof vi.fn>;
  getMeta: ReturnType<typeof vi.fn>;
  setMeta: ReturnType<typeof vi.fn>;
  getIndexedCount: ReturnType<typeof vi.fn>;
  getIndexedRoots: ReturnType<typeof vi.fn>;
  deleteByRoot: ReturnType<typeof vi.fn>;
};

function createMockStore(): MockVectorStore {
  return {
    open: vi.fn(),
    close: vi.fn(),
    upsertBatch: vi.fn(),
    getAllEntries: vi.fn().mockReturnValue([]),
    getMeta: vi.fn().mockReturnValue(null),
    setMeta: vi.fn(),
    getIndexedCount: vi.fn().mockReturnValue(0),
    getIndexedRoots: vi.fn().mockReturnValue([]),
    deleteByRoot: vi.fn(),
  };
}

vi.mock('../../electron/services/image-search/image-vector-store', () => ({
  ImageVectorStore: vi.fn(),
  getImageIndexDbPath: vi.fn(() => '/tmp/test-index.db'),
}));

vi.mock('../../electron/services/image-search/model-cache', () => ({
  MOBILECLIP_MODEL_ID: 'Xenova/mobileclip_s0',
  getImageSearchModelCacheDir: vi.fn(() => '/tmp/model-cache'),
  getImageSearchModelSources: vi.fn(() => []),
  getImageSearchLocalModelPath: vi.fn(() => null),
}));

// Import the module under test AFTER mocks are set up
import { ImageIndexManager, getImageIndexManager } from '../../electron/services/image-search/image-index-manager';
import { Worker } from 'node:worker_threads';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ImageIndexManager', () => {
  let mockStore: MockVectorStore;
  const WorkerMock = Worker as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    WorkerMock.mockClear();
    workerInstances.length = 0;
    mockStore = createMockStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function getLastWorker() {
    const w = workerInstances[workerInstances.length - 1];
    return {
      terminate: w.terminate,
      postMessage: w.postMessage,
      simulateMessage: (msg: unknown) => w.emit('message', msg),
      simulateExit: (code: number) => w.emit('exit', code),
      simulateError: (err: Error) => w.emit('error', err),
    };
  }

  // ─── State machine ────────────────────────────────────────────────────────

  it('startIndexing() transitions state from idle to indexing', () => {
    const manager = new ImageIndexManager(mockStore as any);
    expect(manager.getStatus().state).toBe('idle');

    manager.startIndexing(['/photos']);

    expect(manager.getStatus().state).toBe('indexing');
  });

  it('startIndexing() while already indexing is rejected (no-op)', () => {
    const manager = new ImageIndexManager(mockStore as any);

    manager.startIndexing(['/photos']);
    const firstCallCount = WorkerMock.mock.calls.length;

    // Call startIndexing again while already indexing
    manager.startIndexing(['/photos2']);

    // Worker should not be created again
    expect(WorkerMock.mock.calls.length).toBe(firstCallCount);
    expect(manager.getStatus().state).toBe('indexing');
  });

  it("handleWorkerMessage 'batch' calls vectorStore.upsertBatch with Float32Array embeddings directly", () => {
    const manager = new ImageIndexManager(mockStore as any);
    manager.startIndexing(['/photos']);

    const embedding = new Float32Array(512).fill(0.5);
    getLastWorker().simulateMessage({
      type: 'batch',
      items: [
        { path: '/photos/a.jpg', embedding, fileTime: 1000, size: 2048, root: '/photos' },
      ],
    });

    expect(mockStore.upsertBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        path: '/photos/a.jpg',
        embedding: expect.any(Float32Array),
      }),
    ]);
  });

  it("handleWorkerMessage 'complete' transitions state to idle", () => {
    const manager = new ImageIndexManager(mockStore as any);
    manager.startIndexing(['/photos']);

    getLastWorker().simulateMessage({
      type: 'complete',
      indexed: 5,
      errors: 0,
      skipped: 2,
    });

    const status = manager.getStatus();
    expect(status.state).toBe('idle');
    expect(status.lastIndexedAt).not.toBeNull();
  });

  it("handleWorkerMessage 'error' with fatal=true transitions state to error", () => {
    const manager = new ImageIndexManager(mockStore as any);
    manager.startIndexing(['/photos']);

    getLastWorker().simulateMessage({
      type: 'error',
      message: 'Model load failed',
      fatal: true,
    });

    expect(manager.getStatus().state).toBe('error');
  });

  // ─── Crash recovery ────────────────────────────────────────────────────────

  it('worker exit with non-zero code triggers restart with exponential backoff (1s, 2s, 4s)', () => {
    const manager = new ImageIndexManager(mockStore as any);
    manager.startIndexing(['/photos']);

    const initialCallCount = WorkerMock.mock.calls.length;

    // Simulate first worker crash
    getLastWorker().simulateExit(1);

    // Should not restart immediately
    expect(WorkerMock.mock.calls.length).toBe(initialCallCount);

    // Advance time by 1s (first backoff delay)
    vi.advanceTimersByTime(1000);

    // Worker should be restarted after 1s
    expect(WorkerMock.mock.calls.length).toBe(initialCallCount + 1);

    // Simulate second crash (should backoff 2s)
    getLastWorker().simulateExit(1);
    vi.advanceTimersByTime(1999);
    expect(WorkerMock.mock.calls.length).toBe(initialCallCount + 1); // not yet

    vi.advanceTimersByTime(1);
    expect(WorkerMock.mock.calls.length).toBe(initialCallCount + 2); // now
  });

  it('3 crashes within 30s marks state as unavailable, stops restarting', () => {
    const manager = new ImageIndexManager(mockStore as any);
    manager.startIndexing(['/photos']);

    // Crash 1 — after 1s, restart
    getLastWorker().simulateExit(1);
    vi.advanceTimersByTime(1000);

    // Crash 2 — after 2s, restart
    getLastWorker().simulateExit(1);
    vi.advanceTimersByTime(2000);

    // Crash 3 — should trigger unavailable state, no restart
    const callsBeforeThirdCrash = WorkerMock.mock.calls.length;
    getLastWorker().simulateExit(1);

    vi.advanceTimersByTime(60000); // advance well past any backoff delay

    // State should be unavailable after 3rd crash
    expect(manager.getStatus().state).toBe('unavailable');
    // No new worker should be created after the 3rd crash
    expect(WorkerMock.mock.calls.length).toBe(callsBeforeThirdCrash);
  });

  it('getStatus() returns current state, progress, and indexed count', () => {
    const manager = new ImageIndexManager(mockStore as any);
    mockStore.getIndexedCount.mockReturnValue(42);

    const status = manager.getStatus();

    expect(status).toMatchObject({
      state: 'idle',
      progress: expect.objectContaining({
        indexed: 0,
        total: 0,
        errors: 0,
      }),
      lastIndexedAt: null,
      roots: [],
      totalIndexed: 42,
    });
  });

  it('getVectorStore() returns the injected vector store', () => {
    const manager = new ImageIndexManager(mockStore as any);

    expect(manager.getVectorStore()).toBe(mockStore);
  });

  it('shutdown() terminates worker and closes vector store', () => {
    const manager = new ImageIndexManager(mockStore as any);
    manager.startIndexing(['/photos']);

    const { terminate } = getLastWorker();
    manager.shutdown();

    expect(terminate).toHaveBeenCalled();
    expect(mockStore.close).toHaveBeenCalled();
    expect(manager.getStatus().state).toBe('idle');
  });

  // ─── Dimension mismatch detection ─────────────────────────────────────────

  it('startIndexing() detects embedding_dim mismatch and calls deleteByRoot for all roots', () => {
    // Mock stored dim = 256 (mismatch with current 512)
    mockStore.getMeta.mockReturnValue('256');
    mockStore.getIndexedRoots.mockReturnValue(['/photos', '/downloads']);

    const manager = new ImageIndexManager(mockStore as any);
    manager.startIndexing(['/photos']);

    // Should delete existing data for all indexed roots
    expect(mockStore.deleteByRoot).toHaveBeenCalledWith('/photos');
    expect(mockStore.deleteByRoot).toHaveBeenCalledWith('/downloads');
    // Should set the new embedding_dim
    expect(mockStore.setMeta).toHaveBeenCalledWith('embedding_dim', '512');
  });

  it('startIndexing() with matching embedding_dim does NOT delete existing entries', () => {
    // Mock stored dim = 512 (matches current)
    mockStore.getMeta.mockReturnValue('512');
    mockStore.getIndexedRoots.mockReturnValue(['/photos']);

    const manager = new ImageIndexManager(mockStore as any);
    manager.startIndexing(['/photos']);

    // Should NOT delete any roots
    expect(mockStore.deleteByRoot).not.toHaveBeenCalled();
  });
});

describe('getImageIndexManager singleton', () => {
  it('returns the same instance on multiple calls', () => {
    const manager1 = getImageIndexManager();
    const manager2 = getImageIndexManager();
    expect(manager1).toBe(manager2);
  });
});
