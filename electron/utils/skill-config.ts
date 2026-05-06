/**
 * Skill Config Utilities
 * Direct read/write access to skill configuration in ~/.openclaw/openclaw.json
 * This bypasses the Gateway RPC for faster and more reliable config updates.
 *
 * All file I/O uses async fs/promises to avoid blocking the main thread.
 */
import { readFile, writeFile, access, cp, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { constants } from 'fs';
import { join } from 'path';
import { getOpenClawConfigDir, getOpenClawDir, getOpenClawSkillsDir, getResourcesDir } from './paths';
import { logger } from './logger';
import { withConfigLock } from './config-mutex';

const OPENCLAW_CONFIG_PATH = join(getOpenClawConfigDir(), 'openclaw.json');

interface SkillEntry {
    enabled?: boolean;
    apiKey?: string;
    env?: Record<string, string>;
}

interface OpenClawConfig {
    skills?: {
        entries?: Record<string, SkillEntry>;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface PreinstalledSkillSpec {
    slug: string;
    version?: string;
    autoEnable?: boolean;
}

interface PreinstalledManifest {
    skills?: PreinstalledSkillSpec[];
}

interface PreinstalledLockEntry {
    slug: string;
    version?: string;
}

interface PreinstalledLockFile {
    skills?: PreinstalledLockEntry[];
}

interface PreinstalledMarker {
    source: 'clawx-preinstalled';
    slug: string;
    version: string;
    installedAt: string;
}

async function fileExists(p: string): Promise<boolean> {
    try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/**
 * Read the current OpenClaw config
 */
async function readConfig(): Promise<OpenClawConfig> {
    if (!(await fileExists(OPENCLAW_CONFIG_PATH))) {
        return {};
    }
    try {
        const raw = await readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        logger.error('Failed to read openclaw config:', err);
        return {};
    }
}

/**
 * Write the OpenClaw config
 */
async function writeConfig(config: OpenClawConfig): Promise<void> {
    const json = JSON.stringify(config, null, 2);
    await writeFile(OPENCLAW_CONFIG_PATH, json, 'utf-8');
}

async function setSkillsEnabled(skillKeys: string[], enabled: boolean): Promise<void> {
    if (skillKeys.length === 0) {
        return;
    }
    return withConfigLock(async () => {
        const config = await readConfig();
        if (!config.skills) {
            config.skills = {};
        }
        if (!config.skills.entries) {
            config.skills.entries = {};
        }
        for (const skillKey of skillKeys) {
            const entry = config.skills.entries[skillKey] || {};
            entry.enabled = enabled;
            config.skills.entries[skillKey] = entry;
        }
        await writeConfig(config);
    });
}

/**
 * Get skill config
 */
export async function getSkillConfig(skillKey: string): Promise<SkillEntry | undefined> {
    const config = await readConfig();
    return config.skills?.entries?.[skillKey];
}

/**
 * Update skill config (apiKey and env)
 */
export async function updateSkillConfig(
    skillKey: string,
    updates: { apiKey?: string; env?: Record<string, string> }
): Promise<{ success: boolean; error?: string }> {
    try {
        return await withConfigLock(async () => {
            const config = await readConfig();

            // Ensure skills.entries exists
            if (!config.skills) {
                config.skills = {};
            }
            if (!config.skills.entries) {
                config.skills.entries = {};
            }

            // Get or create skill entry
            const entry = config.skills.entries[skillKey] || {};

            // Update apiKey
            if (updates.apiKey !== undefined) {
                const trimmed = updates.apiKey.trim();
                if (trimmed) {
                    entry.apiKey = trimmed;
                } else {
                    delete entry.apiKey;
                }
            }

            // Update env
            if (updates.env !== undefined) {
                const newEnv: Record<string, string> = {};

                for (const [key, value] of Object.entries(updates.env)) {
                    const trimmedKey = key.trim();
                    if (!trimmedKey) continue;

                    const trimmedVal = value.trim();
                    if (trimmedVal) {
                        newEnv[trimmedKey] = trimmedVal;
                    }
                }

                if (Object.keys(newEnv).length > 0) {
                    entry.env = newEnv;
                } else {
                    delete entry.env;
                }
            }

            // Save entry back
            config.skills.entries[skillKey] = entry;

            await writeConfig(config);
            return { success: true };
        });
    } catch (err) {
        logger.error('Failed to update skill config:', err);
        return { success: false, error: String(err) };
    }
}

/**
 * Get all skill configs (for syncing to frontend)
 */
export async function getAllSkillConfigs(): Promise<Record<string, SkillEntry>> {
    const config = await readConfig();
    return config.skills?.entries || {};
}

/**
 * Built-in skills bundled with KTClaw that should be pre-deployed to
 * ~/.openclaw/skills/ on first launch.  These come from the openclaw package's
 * extensions directory and are available in both dev and packaged builds.
 */
const BUILTIN_SKILLS = [] as const;

/**
 * Ensure built-in skills are deployed to ~/.openclaw/skills/<slug>/.
 * Skips any skill that already has a SKILL.md present (idempotent).
 * Runs at app startup; all errors are logged and swallowed so they never
 * block the normal startup flow.
 */
export async function ensureBuiltinSkillsInstalled(): Promise<void> {
    const skillsRoot = getOpenClawSkillsDir();

    for (const { slug, sourceExtension } of BUILTIN_SKILLS) {
        const targetDir = join(skillsRoot, slug);
        const targetManifest = join(targetDir, 'SKILL.md');

        if (existsSync(targetManifest)) {
            continue; // already installed
        }

        const openclawDir = getOpenClawDir();
        const sourceDir = join(openclawDir, 'extensions', sourceExtension, 'skills', slug);

        if (!existsSync(join(sourceDir, 'SKILL.md'))) {
            logger.warn(`Built-in skill source not found, skipping: ${sourceDir}`);
            continue;
        }

        try {
            await mkdir(targetDir, { recursive: true });
            await cp(sourceDir, targetDir, { recursive: true });
            logger.info(`Installed built-in skill: ${slug} -> ${targetDir}`);
        } catch (error) {
            logger.warn(`Failed to install built-in skill ${slug}:`, error);
        }
    }
}

const PREINSTALLED_MANIFEST_NAME = 'preinstalled-manifest.json';
const PREINSTALLED_MARKER_NAME = '.clawx-preinstalled.json';

async function readPreinstalledManifest(): Promise<PreinstalledSkillSpec[]> {
    const candidates = [
        join(getResourcesDir(), 'skills', PREINSTALLED_MANIFEST_NAME),
        join(process.cwd(), 'resources', 'skills', PREINSTALLED_MANIFEST_NAME),
    ];

    const manifestPath = candidates.find((p) => existsSync(p));
    if (!manifestPath) {
        return [];
    }

    try {
        const raw = await readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as PreinstalledManifest;
        if (!Array.isArray(parsed.skills)) {
            return [];
        }
        return parsed.skills.filter((s): s is PreinstalledSkillSpec => Boolean(s?.slug));
    } catch (error) {
        logger.warn('Failed to read preinstalled-skills manifest:', error);
        return [];
    }
}

function resolvePreinstalledSkillsSourceRoots(): string[] {
    const candidates = [
        join(getResourcesDir(), 'preinstalled-skills'),
        join(process.cwd(), 'build', 'preinstalled-skills'),
        join(__dirname, '../../build/preinstalled-skills'),
    ];

    return candidates.filter((dir, index, all) => existsSync(dir) && all.indexOf(dir) === index);
}

async function readPreinstalledLockVersions(sourceRoot: string): Promise<Map<string, string>> {
    const lockPath = join(sourceRoot, '.preinstalled-lock.json');
    if (!existsSync(lockPath)) {
        return new Map();
    }
    try {
        const raw = await readFile(lockPath, 'utf-8');
        const parsed = JSON.parse(raw) as PreinstalledLockFile;
        const versions = new Map<string, string>();
        for (const entry of parsed.skills || []) {
            const slug = entry.slug?.trim();
            const version = entry.version?.trim();
            if (slug && version) {
                versions.set(slug, version);
            }
        }
        return versions;
    } catch (error) {
        logger.warn('Failed to read preinstalled-skills lock file:', error);
        return new Map();
    }
}

async function tryReadMarker(markerPath: string): Promise<PreinstalledMarker | null> {
    if (!existsSync(markerPath)) {
        return null;
    }
    try {
        const raw = await readFile(markerPath, 'utf-8');
        const parsed = JSON.parse(raw) as PreinstalledMarker;
        if (!parsed?.slug || !parsed?.version) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Ensure third-party preinstalled skills (bundled in app resources) are
 * deployed to ~/.openclaw/skills/<slug>/ as full directories.
 *
 * Policy:
 * - If skill is missing locally, install it.
 * - If local skill exists without our marker, treat as user-managed and never overwrite.
 * - If marker exists with same version, skip.
 * - If marker exists with a different version, replace it with the bundled update.
 */
export async function ensurePreinstalledSkillsInstalled(): Promise<void> {
    const skills = await readPreinstalledManifest();
    if (skills.length === 0) {
        return;
    }

    const sourceRoots = resolvePreinstalledSkillsSourceRoots();
    if (sourceRoots.length === 0) {
        logger.warn('Preinstalled skills source root not found; skipping preinstall.');
        return;
    }
    const lockVersionsByRoot = new Map<string, Map<string, string>>();
    for (const sourceRoot of sourceRoots) {
        lockVersionsByRoot.set(sourceRoot, await readPreinstalledLockVersions(sourceRoot));
    }

    const targetRoot = getOpenClawSkillsDir();
    await mkdir(targetRoot, { recursive: true });
    const toEnable: string[] = [];

    for (const spec of skills) {
        const sourceRoot = sourceRoots.find((root) => existsSync(join(root, spec.slug, 'SKILL.md')));
        const sourceDir = sourceRoot ? join(sourceRoot, spec.slug) : null;
        const sourceManifest = sourceDir ? join(sourceDir, 'SKILL.md') : null;
        if (!sourceDir || !sourceManifest || !existsSync(sourceManifest)) {
            logger.warn(`Preinstalled skill source missing SKILL.md, skipping: ${spec.slug}`);
            continue;
        }

        const targetDir = join(targetRoot, spec.slug);
        const targetManifest = join(targetDir, 'SKILL.md');
        const markerPath = join(targetDir, PREINSTALLED_MARKER_NAME);
        const desiredVersion = lockVersionsByRoot.get(sourceRoot)?.get(spec.slug)
            || (spec.version || 'unknown').trim()
            || 'unknown';
        const marker = await tryReadMarker(markerPath);

        if (existsSync(targetManifest)) {
            if (!marker) {
                logger.info(`Skipping user-managed skill: ${spec.slug}`);
                continue;
            }
            if (marker.version === desiredVersion) {
                continue;
            }
            logger.info(`Updating preinstalled skill ${spec.slug} from ${marker.version} to ${desiredVersion}`);
            try {
                await rm(targetDir, { recursive: true, force: true });
            } catch (error) {
                logger.warn(`Failed to remove stale preinstalled skill ${spec.slug}:`, error);
                continue;
            }
        }

        try {
            await mkdir(targetDir, { recursive: true });
            await cp(sourceDir, targetDir, { recursive: true, force: true });
            const markerPayload: PreinstalledMarker = {
                source: 'clawx-preinstalled',
                slug: spec.slug,
                version: desiredVersion,
                installedAt: new Date().toISOString(),
            };
            await writeFile(markerPath, `${JSON.stringify(markerPayload, null, 2)}\n`, 'utf-8');
            if (spec.autoEnable) {
                toEnable.push(spec.slug);
            }
            logger.info(`Installed preinstalled skill: ${spec.slug} -> ${targetDir}`);
        } catch (error) {
            logger.warn(`Failed to install preinstalled skill ${spec.slug}:`, error);
        }
    }

    if (toEnable.length > 0) {
        try {
            await setSkillsEnabled(toEnable, true);
        } catch (error) {
            logger.warn('Failed to auto-enable preinstalled skills:', error);
        }
    }
}
