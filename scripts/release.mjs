// Release helper: `npm run release -- x.y.z [--dry-run]`.
// main is protected (no direct pushes), so the version bump goes in through a PR and the tag is
// created on the tested merge commit. Only the tag is pushed from here. No dependencies; git and gh
// are called with argument arrays, never a shell string.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const POLL_MS = 10_000;
const TIMEOUT_MS = 30 * 60 * 1000;

export function parseVersion(text) {
  if (typeof text !== 'string' || !VERSION_RE.test(text)) return null;
  return text.split('.').map(Number);
}

/** Numeric compare of two x.y.z strings: negative, zero or positive. Throws on an invalid one. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Invalid version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Highest x.y.z among tags named vX.Y.Z, or null. */
export function latestVersion(tags) {
  let best = null;
  for (const tag of tags) {
    const v = tag.startsWith('v') ? tag.slice(1) : '';
    if (parseVersion(v) && (best === null || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/**
 * Decides what to do. Returns { path: 'tag' | 'pr' } or { error }.
 * 'tag': package.json on main already has the version (bump came in a feature PR).
 * 'pr': a release PR must bump it first.
 */
export function decidePath({ version, packageVersion, latestTag, tagExists }) {
  if (!parseVersion(version)) return { error: `Version "${version}" is not x.y.z.` };
  if (!parseVersion(packageVersion)) return { error: `package.json version "${packageVersion}" is not x.y.z.` };
  if (tagExists) return { error: `Tag v${version} already exists.` };
  if (latestTag !== null && compareVersions(version, latestTag) <= 0) {
    return { error: `Version ${version} is not greater than the latest tag v${latestTag}.` };
  }
  const cmp = compareVersions(packageVersion, version);
  if (cmp === 0) return { path: 'tag' };
  if (cmp > 0) return { error: `package.json is at ${packageVersion}, already past ${version}.` };
  return { path: 'pr' };
}

/**
 * Evaluates the `check` check-runs of a commit plus the CI workflow runs for the same SHA.
 * Returns { state: 'ok' | 'pending' | 'failed' | 'missing', reason }.
 * `skipped` is only trusted when a CI run for the SHA concluded `success` (the gate found the same tree).
 */
export function evaluateCheck(checkRuns, workflowRuns) {
  const runs = (checkRuns ?? []).filter((r) => r && r.name === 'check');
  if (runs.length === 0) return { state: 'missing', reason: 'no check run yet' };
  if (runs.some((r) => r.status !== 'completed')) return { state: 'pending', reason: 'check still running' };
  if (runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'cancelled' || r.conclusion === 'timed_out')) {
    return { state: 'failed', reason: 'check did not pass' };
  }
  if (runs.every((r) => r.conclusion === 'success')) return { state: 'ok', reason: 'check passed' };
  if (runs.every((r) => r.conclusion === 'success' || r.conclusion === 'skipped')) {
    const ci = (workflowRuns ?? []).filter((w) => w && w.status === 'completed');
    if (ci.some((w) => w.conclusion === 'success')) {
      return { state: 'ok', reason: 'check skipped by the gate (same tree already passed), CI run succeeded' };
    }
    if ((workflowRuns ?? []).some((w) => w && w.status !== 'completed')) {
      return { state: 'pending', reason: 'CI workflow run still in progress' };
    }
    return { state: 'failed', reason: 'check skipped but the CI workflow run did not succeed' };
  }
  return { state: 'failed', reason: `unexpected conclusion: ${runs.map((r) => r.conclusion).join(', ')}` };
}

// ---- CLI part ----

class Fail extends Error {}

function run(cmd, args, { dry = false, mutating = false } = {}) {
  if (dry && mutating) {
    console.log(`[dry-run] ${cmd} ${args.join(' ')}`);
    return '';
  }
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCheck(gh, repo, sha, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    let result;
    try {
      const checks = JSON.parse(gh([`repos/${repo}/commits/${sha}/check-runs?check_name=check`]));
      const wf = JSON.parse(gh([`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}`]));
      result = evaluateCheck(checks.check_runs, wf.workflow_runs);
    } catch (e) {
      result = { state: 'pending', reason: `query failed (${e.message.split('\n')[0]})` };
    }
    if (result.state === 'ok') {
      console.log(`${label}: ${result.reason}`);
      return;
    }
    if (result.state === 'failed') throw new Fail(`${label}: ${result.reason}`);
    if (Date.now() > deadline) throw new Fail(`${label}: timed out after 30 minutes (${result.reason})`);
    console.log(`${label}: waiting (${result.reason})`);
    await sleep(POLL_MS);
  }
}

function packageVersion(root) {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
}

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: npm run release -- x.y.z [--dry-run]

Releases x.y.z. If package.json on main already has x.y.z, waits for its check and tags that commit.
Otherwise opens a release PR (release/x.y.z), waits for its check, merges it, then tags the merge commit.
Only the tag is pushed. --dry-run prints the steps and changes nothing.`);
    return;
  }
  const dry = argv.includes('--dry-run');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const version = positional[0];
  if (positional.length !== 1 || !parseVersion(version)) throw new Fail('Usage: npm run release -- x.y.z [--dry-run]');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const git = (args, o) => run('git', args, o);
  const ghCli = (args, o) => run('gh', args, o);
  const ghApi = (args) => run('gh', ['api', ...args]);

  try {
    ghCli(['auth', 'status']);
  } catch {
    throw new Fail('gh is not available or not authenticated (run `gh auth login`).');
  }
  if (git(['status', '--porcelain'])) throw new Fail('The working tree is not clean.');
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') throw new Fail(`Current branch is ${branch}; switch to main.`);
  git(['fetch', 'origin', '--tags']);
  const head = git(['rev-parse', 'HEAD']);
  if (head !== git(['rev-parse', 'origin/main'])) throw new Fail('Local main is not equal to origin/main.');
  const repo = JSON.parse(ghCli(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;

  const tags = git(['tag', '--list', 'v*']).split('\n').filter(Boolean);
  const remoteTags = git(['ls-remote', '--tags', 'origin', `refs/tags/v${version}`]);
  const decision = decidePath({
    version,
    packageVersion: packageVersion(root),
    latestTag: latestVersion(tags),
    tagExists: tags.includes(`v${version}`) || remoteTags !== '',
  });
  if (decision.error) throw new Fail(decision.error);

  let sha = head;
  if (decision.path === 'pr') {
    const rel = `release/${version}`;
    console.log(`package.json is behind: opening release PR ${rel}`);
    git(['switch', '-c', rel, 'origin/main'], { dry, mutating: true });
    run('npm', ['version', version, '--no-git-tag-version'], { dry, mutating: true });
    git(['add', 'package.json', 'package-lock.json'], { dry, mutating: true });
    git(['commit', '-m', `chore(release): ${version}`], { dry, mutating: true });
    git(['push', '-u', 'origin', rel], { dry, mutating: true });
    const url = ghCli(
      ['pr', 'create', '--base', 'main', '--head', rel, '--title', `chore(release): ${version}`, '--body',
        `Bumps the version to ${version}. The tag is created on the merge commit after this PR merges.`],
      { dry, mutating: true },
    );
    if (dry) {
      console.log('[dry-run] wait for the check on the release branch head, then:');
      ghCli(['pr', 'merge', '<pr-url>', '--merge', '--delete-branch'], { dry, mutating: true });
      console.log('[dry-run] gh may already have switched to main and deleted the local branch; each step below tolerates that');
      git(['switch', 'main'], { dry, mutating: true });
      git(['pull', '--ff-only'], { dry, mutating: true });
      console.log(`[dry-run] git branch -D ${rel} (only if it still exists)`);
      sha = '<merge-commit-sha>';
    } else {
      await waitForCheck(ghApi, repo, git(['rev-parse', 'HEAD']), `PR check (${rel})`);
      ghCli(['pr', 'merge', url, '--merge', '--delete-branch']);
      git(['switch', 'main']);
      git(['pull', '--ff-only']);
      if (packageVersion(root) !== version) throw new Fail(`package.json is not ${version} after the merge.`);
      // gh pr merge --delete-branch usually deletes the local branch itself (and switches to main).
      if (git(['branch', '--list', rel])) git(['branch', '-D', rel]);
      sha = git(['rev-parse', 'HEAD']);
    }
  } else {
    console.log(`package.json already at ${version}: tagging the tested commit`);
  }

  if (dry) console.log(`[dry-run] wait for the check on ${sha}`);
  else await waitForCheck(ghApi, repo, sha, `main check (${sha.slice(0, 7)})`);
  git(['tag', '-a', `v${version}`, '-m', `v${version}`, sha], { dry, mutating: true });
  git(['push', 'origin', `v${version}`], { dry, mutating: true });
  console.log(`${dry ? 'Dry run: nothing changed. Would push' : 'Pushed'} tag v${version}. Follow the release: gh run list --workflow release.yml`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Fail ? e.message : `Release failed: ${e.stderr || e.message}`);
    process.exit(1);
  });
}
