import { logger } from '../../utils/logger';
import { getDefaultImageDirectories } from './image-directories';
import { getImageIndexManager } from './image-index-manager';

export const IMAGE_SEARCH_AUTO_INDEX_DELAY_MS = 10_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ImageSearchAutoIndexOptions {
  delayMs?: number;
  env?: Pick<
    NodeJS.ProcessEnv,
    'KTCLAW_ENABLE_IMAGE_SEARCH_AUTO_INDEX' | 'KTCLAW_DISABLE_IMAGE_SEARCH_AUTO_INDEX'
  >;
  getDirectories?: () => string[];
  getManager?: () => {
    startIndexing: (roots: string[]) => void;
  };
  setTimer?: (handler: () => void, delayMs: number) => TimerHandle | number;
  logInfo?: (message: string) => void;
  logWarn?: (message: string, error?: unknown) => void;
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

export function shouldAutoStartImageIndexing(
  env: ImageSearchAutoIndexOptions['env'] = process.env,
): boolean {
  if (isTruthyEnvValue(env.KTCLAW_DISABLE_IMAGE_SEARCH_AUTO_INDEX)) {
    return false;
  }
  return isTruthyEnvValue(env.KTCLAW_ENABLE_IMAGE_SEARCH_AUTO_INDEX);
}

export function scheduleImageSearchAutoIndex(options: ImageSearchAutoIndexOptions = {}): boolean {
  const env = options.env ?? process.env;
  const logInfo = options.logInfo ?? ((message) => logger.info(message));
  const logWarn = options.logWarn ?? ((message, error) => logger.warn(message, error));

  if (!shouldAutoStartImageIndexing(env)) {
    logInfo('Image auto-indexing skipped; set KTCLAW_ENABLE_IMAGE_SEARCH_AUTO_INDEX=1 to enable startup indexing');
    return false;
  }

  const delayMs = options.delayMs ?? IMAGE_SEARCH_AUTO_INDEX_DELAY_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const getDirectories = options.getDirectories ?? getDefaultImageDirectories;
  const getManager = options.getManager ?? getImageIndexManager;

  setTimer(() => {
    try {
      const dirs = getDirectories();
      if (dirs.length === 0) {
        logInfo('Image auto-indexing skipped: no default image directories found');
        return;
      }

      getManager().startIndexing(dirs);
      logInfo(`Auto-indexing started for ${dirs.length} directory(s): ${dirs.join(', ')}`);
    } catch (error) {
      logWarn('Auto-indexing startup failed:', error);
    }
  }, delayMs);

  return true;
}
