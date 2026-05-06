/**
 * ImageIndexManager
 *
 * Singleton that owns the Worker Thread lifecycle for background image indexing.
 * Implements exponential backoff crash recovery and dimension mismatch detection.
 * After first full index completes, starts a chokidar file watcher to keep the
 * index up-to-date with real-time changes (D-11).
 *
 * Design decisions (D-09, D-10, D-11, D-15, SC-3):
 * - D-09: Worker never touches DB directly — manager receives batches and writes via vectorStore
 * - D-10: ImageVectorStore is lazy-open, always-open singleton
 * - D-11: File watcher does NOT start before first full index is complete
 * - D-15: Exponential backoff crash recovery (1s, 2s, 4s, 8s, cap 60s)
 * - SC-3: 3 crashes in 30s window → 'unavailable' state (no infinite loop)
 */
import { Worker } from 'node:worker_threads';
import { join, extname } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { ImageVectorStore } from './image-vector-store';
import {
  getImageSearchModelCacheDir,
  getImageSearchModelSources,
  getImageSearchLocalModelPath,
  MOBILECLIP_MODEL_ID,
} from './model-cache';
import { logger } from '../../utils/logger';

// ─── Constants ───────────────────────────────────────────────────────────────

/** MobileCLIP-S0 output embedding dimension. Must match the sqlite-vec schema. */
const CURRENT_EMBEDDING_DIM = 512;

/** Maximum crashes in a time window before marking as unavailable */
const MAX_CRASHES_IN_WINDOW = 3;

/** Time window (ms) for tracking rapid crashes */
const CRASH_WINDOW_MS = 30_000;

/** Maximum backoff delay between restarts */
const MAX_RESTART_DELAY_MS = 60_000;

/** Batch size for worker */
const INDEXING_BATCH_SIZE = 50;

/** Image file extensions monitored by the file watcher */
const WATCHED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif']);

// ─── Types ───────────────────────────────────────────────────────────────────

type IndexState = 'idle' | 'indexing' | 'error' | 'unavailable';

interface IndexProgress {
  indexed: number;
  total: number;
  errors: number;
  skipped: number;
  currentFile?: string;
}

interface IndexStatus {
  state: IndexState;
  progress: IndexProgress;
  lastIndexedAt: Date | null;
  roots: string[];
  totalIndexed: number;
}

// Worker message types (must match image-index-worker.ts definitions)
type WorkerMessage =
  | {
      type: 'batch';
      items: Array<{
        path: string;
        embedding: Float32Array;
        fileTime: number;
        size: number;
        root: string;
        width?: number;
        height?: number;
        lat?: number;
        lon?: number;
      }>;
    }
  | { type: 'progress'; indexed: number; total: number; errors: number; currentFile?: string }
  | { type: 'complete'; indexed: number; errors: number; skipped: number }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

// ─── ImageIndexManager ────────────────────────────────────────────────────────

export class ImageIndexManager {
  /** Active worker thread reference, null when not indexing */
  private worker: Worker | null = null;

  /** Current state machine state */
  private state: IndexState = 'idle';

  /** Current indexing progress */
  private progress: IndexProgress = { indexed: 0, total: 0, errors: 0, skipped: 0 };

  /** The vector store for reading/writing embeddings */
  private readonly vectorStore: ImageVectorStore;

  /** Currently configured root directories */
  private roots: string[] = [];

  /** Timestamp of the last completed full index run */
  private lastIndexedAt: Date | null = null;

  /** Timestamps of recent crashes for backoff tracking */
  private crashTimestamps: number[] = [];

  /** Base restart delay (1s), doubles on each crash */
  private restartDelay = 1000;

  /** Pending restart timer */
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** chokidar file watcher instance, started after first full index */
  private watcher: FSWatcher | null = null;

  /** Debounce timer for batching rapid file-system changes */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Paths with pending changes awaiting debounce flush */
  private pendingChanges = new Set<string>();

  /** Debounce delay (ms) before triggering incremental re-index */
  private readonly DEBOUNCE_MS = 5000;

  constructor(vectorStore?: ImageVectorStore) {
    this.vectorStore = vectorStore ?? new ImageVectorStore();
  }

  /**
   * Starts background indexing of the given root directories.
   *
   * - Rejects concurrent requests (already indexing)
   * - Rejects if state is 'unavailable' (too many crashes)
   * - Checks embedding_dim in DB metadata and triggers full re-index if mismatched
   * - Gets existing entries for incremental skip map
   * - Spawns Worker Thread with all required workerData
   */
  startIndexing(roots: string[]): void {
    // Reject concurrent indexing
    if (this.worker !== null || this.state === 'indexing') {
      logger.warn('ImageIndexManager: startIndexing() called while already indexing, ignoring');
      return;
    }

    // Reject if permanently unavailable
    if (this.state === 'unavailable') {
      logger.warn('ImageIndexManager: state is unavailable (too many crashes), ignoring startIndexing()');
      return;
    }

    this.roots = roots;
    this.progress = { indexed: 0, total: 0, errors: 0, skipped: 0 };
    this.state = 'indexing';

    // ── Dimension mismatch detection (Pitfall 6 / Blocker 1 fix) ──────────
    this.vectorStore.open();
    const storedDim = this.vectorStore.getMeta('embedding_dim');
    if (storedDim !== null && parseInt(storedDim, 10) !== CURRENT_EMBEDDING_DIM) {
      logger.warn(
        `ImageIndexManager: Embedding dimension changed: stored=${storedDim}, current=${CURRENT_EMBEDDING_DIM}. Re-indexing all roots.`,
      );
      const existingRoots = this.vectorStore.getIndexedRoots();
      for (const root of existingRoots) {
        this.vectorStore.deleteByRoot(root);
      }
      // Update meta so next startup recognizes the correct dim
      this.vectorStore.setMeta('embedding_dim', String(CURRENT_EMBEDDING_DIM));
    }

    // ── Get existing entries for incremental skip map ──────────────────────
    // getAllEntries() returns all path+fileTime pairs — worker uses these to
    // skip files whose mtime hasn't changed since last index.
    const existingEntries = this.vectorStore.getAllEntries();

    // ── Resolve worker path ────────────────────────────────────────────────
    // Worker must be a compiled .js file, not .ts source.
    // At runtime, __dirname points to dist-electron/services/image-search/
    const workerPath = join(__dirname, 'image-index-worker.js');

    logger.info(`ImageIndexManager: Starting indexer worker, ${roots.length} root(s), ${existingEntries.length} existing entries`);

    // ── Spawn Worker Thread ────────────────────────────────────────────────
    this.worker = new Worker(workerPath, {
      workerData: {
        roots,
        modelCacheDir: getImageSearchModelCacheDir(),
        modelSources: getImageSearchModelSources(),
        localModelPath: getImageSearchLocalModelPath(),
        existingEntries,
        batchSize: INDEXING_BATCH_SIZE,
      },
    });

    // Attach message/error/exit handlers
    this.worker.on('message', (msg: WorkerMessage) => this.handleWorkerMessage(msg));
    this.worker.on('error', (err: Error) => {
      logger.error(`ImageIndexManager: Worker error: ${err.message}`);
      // Worker error events are followed by exit event — let handleWorkerExit handle recovery
    });
    this.worker.on('exit', (code: number) => this.handleWorkerExit(code));
  }

  /**
   * Handles messages received from the Worker Thread.
   *
   * - 'batch': Write embeddings to DB via vectorStore.upsertBatch()
   *   NOTE: Worker already sends Float32Array (Warning 5 fix in worker) — no conversion needed
   * - 'progress': Update current progress counters
   * - 'complete': Transition to idle, record timestamp, store model metadata
   * - 'error': If fatal, transition to error state
   * - 'log': Forward to logger
   */
  private handleWorkerMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case 'batch':
        // Worker sends Float32Array embeddings — pass directly to vectorStore (no conversion)
        this.vectorStore.upsertBatch(msg.items);
        break;

      case 'progress':
        this.progress = {
          indexed: msg.indexed,
          total: msg.total,
          errors: msg.errors,
          skipped: this.progress.skipped,
          currentFile: msg.currentFile,
        };
        break;

      case 'complete':
        this.state = 'idle';
        this.lastIndexedAt = new Date();
        this.progress = {
          indexed: msg.indexed,
          total: msg.indexed + msg.skipped,
          errors: msg.errors,
          skipped: msg.skipped,
        };
        this.worker = null;

        // Persist model metadata to DB for future mismatch detection
        this.vectorStore.setMeta('model_id', MOBILECLIP_MODEL_ID);
        this.vectorStore.setMeta('embedding_dim', String(CURRENT_EMBEDDING_DIM));

        logger.info(`ImageIndexManager: Indexing complete — ${msg.indexed} indexed, ${msg.skipped} skipped, ${msg.errors} errors`);

        // Start file watcher after first full index is complete (D-11)
        if (!this.watcher) {
          this.startWatcher(this.roots);
        }
        break;

      case 'error':
        if (msg.fatal) {
          this.state = 'error';
          this.worker = null;
          logger.error(`ImageIndexManager: Fatal worker error: ${msg.message}`);
        } else {
          logger.warn(`ImageIndexManager: Worker non-fatal error: ${msg.message}`);
        }
        break;

      case 'log':
        logger[msg.level](`[ImageIndexWorker] ${msg.message}`);
        break;

      default:
        // Unknown message type — ignore
        break;
    }
  }

  /**
   * Handles worker exit events with exponential backoff crash recovery.
   *
   * - Code 0 = normal exit, do nothing
   * - Non-zero = crash, apply backoff and restart (if under threshold)
   * - 3 crashes in 30s = permanently unavailable
   *
   * Backoff formula: min(1000 * 2^(crashCount-1), 60000)
   * Results in: 1s, 2s, 4s, 8s, ... up to 60s cap
   */
  private handleWorkerExit(code: number): void {
    this.worker = null;

    if (code === 0) {
      // Normal exit — handled by 'complete' message
      return;
    }

    logger.warn(`ImageIndexManager: Worker exited with code ${code}`);

    const now = Date.now();

    // Record this crash timestamp
    this.crashTimestamps.push(now);

    // Clean up timestamps outside the 30s window
    this.crashTimestamps = this.crashTimestamps.filter(
      (t) => now - t <= CRASH_WINDOW_MS,
    );

    const recentCrashCount = this.crashTimestamps.length;

    // Check if we've exceeded the crash threshold
    if (recentCrashCount >= MAX_CRASHES_IN_WINDOW) {
      this.state = 'unavailable';
      logger.error(
        `ImageIndexManager: ${recentCrashCount} crashes in ${CRASH_WINDOW_MS}ms — marking as unavailable. Semantic indexing disabled.`,
      );
      return;
    }

    // Calculate exponential backoff delay
    // crash 1 → 1s, crash 2 → 2s, crash 3 would be 4s but stops at unavailable
    const delay = Math.min(
      this.restartDelay * Math.pow(2, recentCrashCount - 1),
      MAX_RESTART_DELAY_MS,
    );

    logger.warn(
      `ImageIndexManager: Scheduling restart in ${delay}ms (crash ${recentCrashCount}/${MAX_CRASHES_IN_WINDOW - 1})`,
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      logger.info('ImageIndexManager: Restarting worker after backoff');
      // Reset state to idle so startIndexing() accepts the restart
      this.state = 'idle';
      this.startIndexing(this.roots);
    }, delay);
  }

  /**
   * Returns the current indexing status.
   */
  getStatus(): IndexStatus {
    return {
      state: this.state,
      progress: { ...this.progress },
      lastIndexedAt: this.lastIndexedAt,
      roots: [...this.roots],
      totalIndexed: this.vectorStore.getIndexedCount(),
    };
  }

  /**
   * Terminates the worker, cancels pending restart, and closes the vector store.
   * Safe to call from app.before-quit event handler.
   */
  shutdown(): void {
    this.stopWatcher();
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.worker !== null) {
      this.worker.terminate().catch(() => {
        // Ignore termination errors during shutdown
      });
      this.worker = null;
    }
    this.vectorStore.close();
    this.state = 'idle';
    logger.info('ImageIndexManager: Shutdown complete');
  }

  /**
   * Starts the chokidar file watcher on the given root directories.
   *
   * Called automatically after the first full index completes (D-11).
   * Guards against double-start — if `this.watcher` already exists, returns early.
   *
   * File events are debounced at 5s to avoid triggering re-indexing on every
   * write during a large file copy. Deleted files are removed from the index
   * immediately (no debounce needed).
   */
  startWatcher(roots: string[]): void {
    if (this.watcher) {
      // Already watching — do not create a second watcher
      return;
    }

    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 2000 },
      ignored: /(^|[/\\])\../,
      depth: 20,
    });

    const scheduleChange = (filePath: string) => {
      const ext = extname(filePath).toLowerCase();
      if (!WATCHED_EXTENSIONS.has(ext)) return;
      this.pendingChanges.add(filePath);
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        const changedFiles = [...this.pendingChanges];
        this.pendingChanges.clear();
        this.indexChangedFiles(changedFiles);
      }, this.DEBOUNCE_MS);
    };

    this.watcher
      .on('add', scheduleChange)
      .on('change', scheduleChange)
      .on('unlink', (filePath: string) => {
        const ext = extname(filePath).toLowerCase();
        if (!WATCHED_EXTENSIONS.has(ext)) return;
        try {
          this.vectorStore.deleteByPath(filePath);
          logger.info(`ImageIndexManager: Removed from index: ${filePath}`);
        } catch (err) {
          logger.warn(`ImageIndexManager: Failed to remove from index: ${filePath}`, err);
        }
      })
      .on('error', (err: unknown) => {
        logger.warn('ImageIndexManager: File watcher error:', err);
      });

    logger.info(`ImageIndexManager: File watcher started on ${roots.length} root(s)`);
  }

  /**
   * Triggers incremental re-indexing for a set of changed files.
   *
   * If a full scan is currently in progress, the changed files are added to
   * `pendingChanges` so they get picked up on the next watcher fire.
   * Otherwise, triggers a full incremental re-index via startIndexing() —
   * the incremental skip map ensures only changed files (updated mtimes) get
   * re-embedded.
   */
  private indexChangedFiles(files: string[]): void {
    if (this.state === 'indexing') {
      // Full scan in progress — re-queue changed files for later
      for (const f of files) this.pendingChanges.add(f);
      logger.info(`ImageIndexManager: Deferred ${files.length} changed file(s) — full index in progress`);
      return;
    }

    logger.info(`ImageIndexManager: ${files.length} changed file(s) detected — triggering incremental re-index`);
    this.startIndexing(this.roots);
  }

  /**
   * Stops the chokidar file watcher and clears any pending debounce timer.
   */
  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close().catch(() => {
        // Ignore errors on close
      });
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges.clear();
    logger.info('ImageIndexManager: File watcher stopped');
  }

  /**
   * Exposes the underlying vector store for image search queries.
   */
  getVectorStore(): ImageVectorStore {
    return this.vectorStore;
  }

  /**
   * Returns true if the index is ready for queries (idle + has indexed content).
   */
  isIndexReady(): boolean {
    return this.state !== 'indexing' && this.vectorStore.getIndexedCount() > 0;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let managerInstance: ImageIndexManager | null = null;

/**
 * Returns the singleton ImageIndexManager instance.
 * Lazily constructs the manager on first access.
 */
export function getImageIndexManager(): ImageIndexManager {
  managerInstance ??= new ImageIndexManager();
  return managerInstance;
}
