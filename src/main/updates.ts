import { z } from 'zod';
import type { AboutLink, LatestCheck } from '@shared/ipc';

/** The repository, fixed. The only place a page the app opens in the browser gets its address from. */
export const REPOSITORY_URL = 'https://github.com/marcostmunhoz/Cais';
export const RELEASES_PAGE_URL = `${REPOSITORY_URL}/releases`;
/** GitHub's "latest release" endpoint (no prereleases, no drafts). */
export const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/marcostmunhoz/Cais/releases/latest';

/** Same as `fetch` for what this module needs: the app passes `net.fetch` (system proxy and certificates), tests a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const CHECK_TIMEOUT_MS = 5000;
/** An answer is kept this long, so repeated clicks do not spend GitHub's 60 requests per hour per IP. */
export const CHECK_CACHE_MS = 60 * 60 * 1000;
/** A failure is remembered briefly, so a person hammering the button does not hammer the server. */
export const CHECK_FAILURE_CACHE_MS = 30 * 1000;
/** A release answer is a few KB; anything much larger is not what we asked for. */
const MAX_BODY_CHARS = 2_000_000;

const TAG = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** `v1.2.3` (the only shape a release tag has) to `[1, 2, 3]`; undefined for anything else. */
export function parseTag(tag: string): [number, number, number] | undefined {
  const match = TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** `1.2.3` (an app version, no `v`) to `[1, 2, 3]`. Prerelease or build suffixes are ignored; undefined when it is not numeric. */
export function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Numeric, part by part: 0.10.0 is newer than 0.9.9. Negative, zero or positive like a comparator. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The release page of a validated tag. Built here from the tag, never taken from the answer's own links. */
export function releasePageUrl(tag: string): string {
  if (!parseTag(tag)) throw new Error('invalid release tag');
  return `${REPOSITORY_URL}/releases/tag/${tag}`;
}

// only tag_name is read: html_url and every other field of the answer are ignored on purpose
const latestRelease = z.object({ tag_name: z.string().regex(TAG) });

export interface ReleaseCheckerOptions {
  /** The running app's version (`app.getVersion()`). */
  version: string;
  fetch: FetchLike;
  /** The releases API address; the test hook may point it at a local fake. */
  url?: string;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Asks GitHub for the newest release, on demand. One GET, no token, no cookies, 5 s limit; the answer is validated
 * (`tag_name` must be `vX.Y.Z`) and cached for an hour. Every failure is `unavailable`: the window never shows
 * technical text. It never downloads or installs anything.
 */
export class ReleaseChecker {
  private readonly url: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cached: { at: number; ttl: number; result: LatestCheck } | undefined;
  private inFlight: Promise<LatestCheck> | undefined;
  /** The newest tag the last successful check saw (validated), for `linkUrl('release')`. */
  private latestTag: string | undefined;

  constructor(private readonly options: ReleaseCheckerOptions) {
    this.url = options.url ?? LATEST_RELEASE_API_URL;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  }

  async check(): Promise<LatestCheck> {
    if (this.cached && this.now() - this.cached.at < this.cached.ttl) return this.cached.result;
    // two clicks in a row share one request
    this.inFlight ??= this.fetchLatest().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** The address to open for `target`. `release` falls back to the releases list until a check found a newer version. */
  linkUrl(target: AboutLink): string {
    if (target === 'repository') return REPOSITORY_URL;
    if (target === 'release' && this.latestTag) return releasePageUrl(this.latestTag);
    return RELEASES_PAGE_URL;
  }

  private async fetchLatest(): Promise<LatestCheck> {
    const result = await this.request();
    const ttl = result.status === 'unavailable' ? CHECK_FAILURE_CACHE_MS : CHECK_CACHE_MS;
    this.cached = { at: this.now(), ttl, result };
    return result;
  }

  private async request(): Promise<LatestCheck> {
    const unavailable: LatestCheck = { status: 'unavailable' };
    const current = parseVersion(this.options.version);
    if (!current) return unavailable;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.options.fetch(this.url, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Cais/${this.options.version}` },
        signal: controller.signal,
        credentials: 'omit',
      });
      if (!response.ok) return unavailable;
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) return unavailable;
      const parsed = latestRelease.safeParse(JSON.parse(text));
      if (!parsed.success) return unavailable;
      const tag = parsed.data.tag_name;
      const latest = parseTag(tag)!;
      const label = tag.slice(1);
      if (compareVersions(latest, current) > 0) {
        this.latestTag = tag;
        return { status: 'newer', latest: label };
      }
      return { status: 'current', latest: label };
    } catch {
      // network, timeout, invalid JSON: all the same to the person
      return unavailable;
    } finally {
      clearTimeout(timer);
    }
  }
}
