import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_CACHE_MS,
  CHECK_FAILURE_CACHE_MS,
  LATEST_RELEASE_API_URL,
  RELEASES_PAGE_URL,
  REPOSITORY_URL,
  ReleaseChecker,
  compareVersions,
  parseTag,
  parseVersion,
  releasePageUrl,
  type FetchLike,
} from '@main/updates';
import type { LogEvent } from '@main/log';

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function rig(version: string, reply: (call: { url: string; init: RequestInit }) => Response | Promise<Response>, timeoutMs?: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  let clock = 1_000_000;
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return reply(call);
  };
  const checker = new ReleaseChecker({ version, fetch, now: () => clock, ...(timeoutMs ? { timeoutMs } : {}) });
  return { calls, checker, advance: (ms: number) => (clock += ms) };
}

describe('version helpers', () => {
  it('compares numerically, part by part', () => {
    expect(compareVersions([0, 10, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([0, 9, 9], [0, 10, 0])).toBeLessThan(0);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(compareVersions([2, 0, 0], [1, 99, 99])).toBeGreaterThan(0);
  });

  it('accepts only vX.Y.Z tags', () => {
    expect(parseTag('v0.2.0')).toEqual([0, 2, 0]);
    expect(parseTag('v10.20.30')).toEqual([10, 20, 30]);
    for (const bad of ['0.2.0', 'v0.2', 'v0.2.0-rc.1', 'v0.2.0 ', ' v0.2.0', 'v1.2.3.4', 'V1.2.3', 'v1.2.x', '', 'v1234567.0.0', 'latest']) {
      expect(parseTag(bad), bad).toBeUndefined();
    }
  });

  it('reads the app version, ignoring a prerelease suffix', () => {
    expect(parseVersion('0.1.1')).toEqual([0, 1, 1]);
    expect(parseVersion('0.2.0-beta.1')).toEqual([0, 2, 0]);
    expect(parseVersion('dev')).toBeUndefined();
  });

  it('builds the release page from the tag, and refuses anything else', () => {
    expect(releasePageUrl('v0.2.0')).toBe('https://github.com/marcostmunhoz/Cais/releases/tag/v0.2.0');
    expect(() => releasePageUrl('v0.2.0/../../evil')).toThrow();
    expect(() => releasePageUrl('https://evil.example/x')).toThrow();
  });
});

describe('ReleaseChecker', () => {
  it('reports a newer version', async () => {
    const { checker } = rig('0.1.1', () => json({ tag_name: 'v0.2.0' }));
    expect(await checker.check()).toEqual({ status: 'newer', latest: '0.2.0' });
  });

  it('compares 0.10.0 above 0.9.9', async () => {
    const { checker } = rig('0.9.9', () => json({ tag_name: 'v0.10.0' }));
    expect(await checker.check()).toEqual({ status: 'newer', latest: '0.10.0' });
  });

  it('reports the same version as current', async () => {
    const { checker } = rig('0.1.1', () => json({ tag_name: 'v0.1.1' }));
    expect(await checker.check()).toEqual({ status: 'current', latest: '0.1.1' });
  });

  it('treats an older upstream (a build ahead of the releases) as current', async () => {
    const { checker } = rig('0.3.0', () => json({ tag_name: 'v0.2.0' }));
    expect(await checker.check()).toEqual({ status: 'current', latest: '0.2.0' });
  });

  it('sends one GET to the releases API with no credentials of any kind', async () => {
    const { calls, checker } = rig('0.1.1', () => json({ tag_name: 'v0.1.1' }));
    await checker.check();
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(LATEST_RELEASE_API_URL);
    expect(url).toBe('https://api.github.com/repos/marcostmunhoz/Cais/releases/latest');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('omit');
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('Cais/0.1.1');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(Object.keys(headers).map((k) => k.toLowerCase()).sort()).toEqual(['accept', 'user-agent']);
  });

  it('never reads a token from the environment', async () => {
    process.env.GITHUB_TOKEN = 'ghp_secret';
    try {
      const { calls, checker } = rig('0.1.1', () => json({ tag_name: 'v0.1.1' }));
      await checker.check();
      expect(JSON.stringify(calls[0]!.init)).not.toContain('ghp_secret');
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it.each([
    ['a repository without releases or private (404)', () => json({ message: 'Not Found' }, 404)],
    ['the rate limit (403)', () => json({ message: 'rate limit exceeded' }, 403)],
    ['too many requests (429)', () => json('', 429)],
    ['a server error (500)', () => json('', 500)],
    ['malformed JSON', () => json('{ not json')],
    ['an empty body', () => json('')],
    ['an answer with no tag', () => json({ name: 'x' })],
    ['a tag that is not vX.Y.Z', () => json({ tag_name: 'v0.2.0-rc.1' })],
    ['a tag with path tricks', () => json({ tag_name: 'v0.2.0/../x' })],
    ['a tag of the wrong type', () => json({ tag_name: 7 })],
    ['a body far larger than a release', () => json(JSON.stringify({ tag_name: 'v9.0.0', pad: 'x'.repeat(2_100_000) }))],
  ])('is unavailable for %s', async (_name, reply) => {
    const { checker } = rig('0.1.1', reply);
    expect(await checker.check()).toEqual({ status: 'unavailable' });
  });

  it('is unavailable when the network fails', async () => {
    const { checker } = rig('0.1.1', () => {
      throw new TypeError('fetch failed');
    });
    expect(await checker.check()).toEqual({ status: 'unavailable' });
  });

  it('gives up after the time limit', async () => {
    const { checker } = rig(
      '0.1.1',
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      30,
    );
    expect(await checker.check()).toEqual({ status: 'unavailable' });
  });

  it('keeps an answer for an hour', async () => {
    const { calls, checker, advance } = rig('0.1.1', () => json({ tag_name: 'v0.2.0' }));
    await checker.check();
    advance(CHECK_CACHE_MS - 1);
    expect(await checker.check()).toEqual({ status: 'newer', latest: '0.2.0' });
    expect(calls).toHaveLength(1);
    advance(2);
    await checker.check();
    expect(calls).toHaveLength(2);
  });

  it('remembers a failure only briefly', async () => {
    let fail = true;
    const { calls, checker, advance } = rig('0.1.1', () => (fail ? json('', 429) : json({ tag_name: 'v0.2.0' })));
    expect(await checker.check()).toEqual({ status: 'unavailable' });
    advance(CHECK_FAILURE_CACHE_MS - 1);
    expect(await checker.check()).toEqual({ status: 'unavailable' });
    expect(calls).toHaveLength(1);
    fail = false;
    advance(2);
    expect(await checker.check()).toEqual({ status: 'newer', latest: '0.2.0' });
    expect(calls).toHaveLength(2);
  });

  it('shares one request between two clicks in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls, checker } = rig('0.1.1', async () => {
      await gate;
      return json({ tag_name: 'v0.2.0' });
    });
    const first = checker.check();
    const second = checker.check();
    release();
    expect(await first).toEqual(await second);
    expect(calls).toHaveLength(1);
  });

  it('is unavailable (and sends nothing) when the app version is not numeric', async () => {
    const { calls, checker } = rig('dev', () => json({ tag_name: 'v0.2.0' }));
    expect(await checker.check()).toEqual({ status: 'unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('uses the address it was given (the test hook)', async () => {
    const calls: string[] = [];
    const checker = new ReleaseChecker({
      version: '0.1.1',
      url: 'http://127.0.0.1:1/latest',
      fetch: async (url) => {
        calls.push(url);
        return json({ tag_name: 'v0.1.1' });
      },
    });
    await checker.check();
    expect(calls).toEqual(['http://127.0.0.1:1/latest']);
  });
});

describe('ReleaseChecker: failure log', () => {
  function logged(version: string, reply: () => Response | Promise<Response>, timeoutMs?: number) {
    const events: LogEvent[] = [];
    let clock = 1_000_000;
    const checker = new ReleaseChecker({
      version,
      fetch: async () => reply(),
      now: () => (clock += 7),
      log: (event) => events.push(event),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    return { checker, events };
  }

  it.each([
    ['http-404', () => json('not found', 404)],
    ['http-500', () => json('', 500)],
    ['http-403', () => new Response('{"message":"API rate limit exceeded for 1.2.3.4"}', { status: 403 })],
    ['network', () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com'))],
    ['body-too-large', () => json(`{"tag_name":"v0.2.0","pad":"${'x'.repeat(2_000_001)}"}`)],
    ['invalid-json', () => json('<html>not json</html>')],
    ['invalid-shape', () => json({ tag_name: 'latest' })],
  ])('logs %s once, with the duration and nothing from the response', async (reason, reply) => {
    const { checker, events } = logged('0.1.1', reply);
    expect(await checker.check()).toEqual({ status: 'unavailable' });
    expect(events).toEqual([{ kind: 'update-check-failed', reason, ms: expect.any(Number) }]);
    const line = JSON.stringify(events);
    expect(line).not.toContain('rate limit');
    expect(line).not.toContain('api.github.com');
    expect(line).not.toContain('not json');
  });

  it('logs timeout when the request is aborted', async () => {
    const events: LogEvent[] = [];
    const checker = new ReleaseChecker({
      version: '0.1.1',
      timeoutMs: 20,
      log: (event) => events.push(event),
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    expect(await checker.check()).toEqual({ status: 'unavailable' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'update-check-failed', reason: 'timeout' });
  });

  it('logs invalid-current-version without sending anything', async () => {
    const { checker, events } = logged('dev', () => json({ tag_name: 'v0.2.0' }));
    expect(await checker.check()).toEqual({ status: 'unavailable' });
    expect(events).toEqual([{ kind: 'update-check-failed', reason: 'invalid-current-version', ms: expect.any(Number) }]);
  });

  it('logs nothing on success, and one line per real request (the cached failure does not repeat)', async () => {
    const ok = logged('0.1.1', () => json({ tag_name: 'v0.2.0' }));
    await ok.checker.check();
    expect(ok.events).toEqual([]);
    const bad = logged('0.1.1', () => json('', 500));
    await bad.checker.check();
    await bad.checker.check();
    expect(bad.events).toHaveLength(1);
  });

  it('a log that throws does not change the answer', async () => {
    const checker = new ReleaseChecker({
      version: '0.1.1',
      fetch: async () => json('', 500),
      log: () => {
        throw new Error('disk full');
      },
    });
    expect(await checker.check()).toEqual({ status: 'unavailable' });
  });
});

describe('links', () => {
  it('opens only fixed addresses, and the release page of the validated tag', async () => {
    const { checker } = rig('0.1.1', () => json({ tag_name: 'v0.2.0', html_url: 'https://evil.example/phish' }));
    expect(checker.linkUrl('repository')).toBe(REPOSITORY_URL);
    // before any check, or when no newer version was found, "release" is the list of releases
    expect(checker.linkUrl('release')).toBe(RELEASES_PAGE_URL);
    expect(checker.linkUrl('releases')).toBe(RELEASES_PAGE_URL);
    await checker.check();
    expect(checker.linkUrl('release')).toBe('https://github.com/marcostmunhoz/Cais/releases/tag/v0.2.0');
    expect(checker.linkUrl('release')).not.toContain('evil');
  });

  it('does not take a page from an answer with a bad tag', async () => {
    const { checker } = rig('0.1.1', () => json({ tag_name: 'v9.9.9/../../x', html_url: 'https://evil.example' }));
    await checker.check();
    expect(checker.linkUrl('release')).toBe(RELEASES_PAGE_URL);
  });
});

describe('the About channels', () => {
  async function registered(failOpen = false) {
    vi.resetModules();
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<any>>();
    vi.doMock('electron', () => ({
      ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<any>) => handlers.set(channel, fn) },
    }));
    const { registerIpc } = await import('@main/ipc');
    const { CHANNELS } = await import('@shared/ipc');
    const opened: string[] = [];
    const { checker } = rig('0.1.1', () => json({ tag_name: 'v0.2.0' }));
    const main = {};
    const other = {};
    registerIpc({
      store: {},
      tabs: {},
      scripts: {},
      agents: {},
      gcloud: {},
      sessions: {},
      isMainWindow: (contents: unknown) => contents === main,
      about: {
        info: () => ({ version: '0.1.1', electron: '1', chromium: '2', node: '3', system: 'linux x64', repository: REPOSITORY_URL }),
        releases: checker,
        openExternal: async (url: string) => {
          if (failOpen) throw new Error('no handler');
          opened.push(url);
        },
      },
    } as never);
    const call = (channel: string, sender: unknown, ...args: unknown[]) => handlers.get(channel)!({ sender }, ...args);
    return { call, CHANNELS, opened, main, other };
  }

  it('answers only the main window', async () => {
    const { call, CHANNELS, main, other } = await registered();
    expect((await call(CHANNELS.appAbout, main)).ok).toBe(true);
    for (const channel of [CHANNELS.appAbout, CHANNELS.appCheckLatest]) expect((await call(channel, other)).ok).toBe(false);
    expect((await call(CHANNELS.appOpenLink, other, 'repository')).ok).toBe(false);
  });

  it('answers ok:false when the system cannot open the address', async () => {
    const { call, CHANNELS, opened, main } = await registered(true);
    const result = await call(CHANNELS.appOpenLink, main, 'repository');
    expect(result.ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it('opens the fixed repository address and nothing the renderer names', async () => {
    const { call, CHANNELS, opened, main } = await registered();
    expect((await call(CHANNELS.appOpenLink, main, 'repository')).ok).toBe(true);
    expect(opened).toEqual([REPOSITORY_URL]);
    for (const bad of ['https://evil.example', 'file:///etc/passwd', '', 7, undefined, { url: 'https://evil.example' }]) {
      const result = await call(CHANNELS.appOpenLink, main, bad);
      expect(result.ok, String(bad)).toBe(false);
    }
    // extra arguments are refused too
    expect((await call(CHANNELS.appOpenLink, main, 'repository', 'https://evil.example')).ok).toBe(false);
    expect((await call(CHANNELS.appCheckLatest, main, 'https://evil.example')).ok).toBe(false);
    expect(opened).toEqual([REPOSITORY_URL]);
  });

  it('opens the release page only after a check found it', async () => {
    const { call, CHANNELS, opened, main } = await registered();
    await call(CHANNELS.appOpenLink, main, 'release');
    expect((await call(CHANNELS.appCheckLatest, main)).value).toEqual({ status: 'newer', latest: '0.2.0' });
    await call(CHANNELS.appOpenLink, main, 'release');
    expect(opened).toEqual([RELEASES_PAGE_URL, 'https://github.com/marcostmunhoz/Cais/releases/tag/v0.2.0']);
  });
});
