import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { POWERBAR_VERSION } from './version.js';

const RELEASE_REPO = 'Qifei-C/codex-powerbar';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30 * 1000;

export interface UpdateCheckCache {
  readonly lastCheck: string;
  readonly latestVersion: string;
  readonly currentVersion: string;
}

export interface UpdateHint {
  readonly version: string;
}

const notifiedSessions = new Set<string>();

function powerbarDir(): string {
  return path.join(os.homedir(), '.powerbar');
}

function cacheFilePath(): string {
  return path.join(powerbarDir(), 'update-check.json');
}

function lockFilePath(): string {
  return path.join(powerbarDir(), 'update-check.lock');
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((segment) => {
    const value = Number.parseInt(segment, 10);
    return Number.isNaN(value) ? 0 : value;
  });
  const pb = b.replace(/^v/, '').split('.').map((segment) => {
    const value = Number.parseInt(segment, 10);
    return Number.isNaN(value) ? 0 : value;
  });
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export function readUpdateCache(): UpdateCheckCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf8')) as Partial<UpdateCheckCache>;
    if (
      typeof raw.lastCheck === 'string'
      && typeof raw.latestVersion === 'string'
      && typeof raw.currentVersion === 'string'
    ) {
      return raw as UpdateCheckCache;
    }
  } catch {
    // Missing or invalid cache is treated as absent.
  }
  return null;
}

export function writeUpdateCache(cache: UpdateCheckCache): void {
  try {
    fs.mkdirSync(powerbarDir(), { recursive: true });
    const tmp = `${cacheFilePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, cacheFilePath());
  } catch {
    // Silent by design: update checks never surface errors to the user.
  }
}

export function shouldCheck(cache: UpdateCheckCache | null, nowMs: number): boolean {
  if (!cache) return true;
  const lastMs = new Date(cache.lastCheck).getTime();
  if (Number.isNaN(lastMs)) return true;
  return nowMs - lastMs >= CHECK_INTERVAL_MS;
}

function releaseCheckLock(): void {
  try {
    fs.rmSync(lockFilePath(), { force: true });
  } catch {
    // Silent cleanup.
  }
}

function acquireCheckLock(nowMs: number): boolean {
  try {
    fs.mkdirSync(powerbarDir(), { recursive: true });
    const lock = lockFilePath();
    try {
      const existing = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10);
      if (!Number.isNaN(existing) && nowMs - existing < LOCK_STALE_MS) return false;
      fs.rmSync(lock, { force: true });
    } catch {
      // No existing lock or unreadable lock file.
    }
    fs.writeFileSync(lock, String(nowMs), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function fireAndForgetUpdateCheck(currentVersion = POWERBAR_VERSION): void {
  const nowMs = Date.now();
  const cache = readUpdateCache();
  if (!shouldCheck(cache, nowMs)) return;
  if (!acquireCheckLock(nowMs)) return;

  try {
    const child = spawn(
      process.execPath,
      [process.argv[1] ?? '', '--update-check-bg', currentVersion],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch {
    releaseCheckLock();
  }
}

export async function fetchAndCacheLatestVersion(currentVersion = POWERBAR_VERSION): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${RELEASE_REPO}/releases`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'powerbar',
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) return;

    const releases = await res.json() as Array<{ tag_name?: string; prerelease?: boolean; draft?: boolean }>;
    const powerbarRelease = releases.find(
      (release) => release.tag_name && /^v\d/.test(release.tag_name) && !release.prerelease && !release.draft,
    );
    if (!powerbarRelease?.tag_name) return;

    writeUpdateCache({
      lastCheck: new Date().toISOString(),
      latestVersion: powerbarRelease.tag_name.replace(/^v/, ''),
      currentVersion,
    });
  } catch {
    // Silent by design.
  } finally {
    clearTimeout(timer);
    releaseCheckLock();
  }
}

export function getUpdateHint(currentVersion = POWERBAR_VERSION, sessionId?: string): UpdateHint | null {
  const cache = readUpdateCache();
  if (!cache) return null;
  if (compareVersions(currentVersion, cache.latestVersion) >= 0) return null;

  if (sessionId) {
    if (notifiedSessions.has(sessionId)) return null;
    notifiedSessions.add(sessionId);
  }

  return { version: cache.latestVersion };
}

export function resetUpdateCheckStateForTest(): void {
  notifiedSessions.clear();
  releaseCheckLock();
}
