import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { m } from '@shared/i18n';

export interface InstallResult {
  ok: boolean;
  /** Message for the person, in the app locale. */
  message: string;
  linkPath?: string;
}

/**
 * Links the bundled `cais.mjs` as `cais` in the first directory that accepts it:
 * `/usr/local/bin`, then `~/.local/bin`. Never overwrites a file that is not our own link.
 * `candidates` and `pathEnv` are parameters so tests use a temp directory (never the real machine).
 */
export function installCli(opts: { target: string; candidates: string[]; pathEnv: string }): InstallResult {
  const target = resolve(opts.target);
  if (!existsSync(target)) {
    return { ok: false, message: m().mainMisc.cliInstall.targetMissing };
  }
  const failures: string[] = [];
  for (const dir of opts.candidates) {
    const linkPath = join(dir, 'cais');
    try {
      mkdirSync(dir, { recursive: true });
      let existing: ReturnType<typeof lstatSync> | undefined;
      try {
        existing = lstatSync(linkPath);
      } catch {
        existing = undefined;
      }
      if (existing) {
        if (!existing.isSymbolicLink()) {
          failures.push(m().mainMisc.cliInstall.notOurLink({ path: linkPath }));
          continue;
        }
        const current = readlinkSync(linkPath);
        if (resolve(dirname(linkPath), current) === target) {
          return done(linkPath, dir, opts.pathEnv, true);
        }
        if (!/cli[\\/]cais\.mjs$|out[\\/]cli[\\/]cais\.mjs$/.test(current)) {
          failures.push(m().mainMisc.cliInstall.otherProgram({ path: linkPath }));
          continue;
        }
        unlinkSync(linkPath);
      }
      symlinkSync(target, linkPath);
      return done(linkPath, dir, opts.pathEnv, false);
    } catch (error) {
      failures.push(
        m().mainMisc.cliInstall.dirFailed({ dir, reason: (error as NodeJS.ErrnoException).code ?? m().mainMisc.cliInstall.noPermission }),
      );
    }
  }
  return { ok: false, message: m().mainMisc.cliInstall.failed({ failures: failures.join(' ') }) };
}

function done(linkPath: string, dir: string, pathEnv: string, already: boolean): InstallResult {
  const onPath = pathEnv.split(delimiter).some((p) => resolve(p) === resolve(dir));
  const t = m().mainMisc.cliInstall;
  const base = already ? t.alreadyInstalled({ path: linkPath }) : t.installed({ path: linkPath });
  return {
    ok: true,
    linkPath,
    message: onPath ? base : `${base} ${t.notOnPath({ dir })}`,
  };
}
