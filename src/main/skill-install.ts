import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { m } from '@shared/i18n';

export type SkillInstallStatus = 'installed' | 'updated' | 'unchanged' | 'refused';

export interface SkillInstallResult {
  ok: boolean;
  status: SkillInstallStatus;
  /** Message for the person, in the app locale. */
  message: string;
  /** `<skillsDir>/cais/SKILL.md`, when the install got that far. */
  path?: string;
}

/** A skill file is a few KB; anything much larger in that place is not ours. */
const MAX_EXISTING_BYTES = 1024 * 1024;

/** True when the YAML frontmatter at the top of `text` has `name: cais` (quotes allowed). */
export function isCaisSkill(text: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return false;
  return /^name:[ \t]*(?:cais|"cais"|'cais')[ \t]*$/m.test(match[1]!);
}

/**
 * The folder the user picked may be the installed skill folder itself (`~/.claude/skills/cais`): then the skills folder
 * is its parent. Only when that folder holds a Cais SKILL.md, so a folder that merely happens to be called `cais` is left as picked.
 */
export function resolveSkillsDir(picked: string): string {
  if (basename(picked) !== 'cais') return picked;
  try {
    const file = join(picked, 'SKILL.md');
    const stat = lstatSync(file);
    if (stat.isFile() && stat.size <= MAX_EXISTING_BYTES && isCaisSkill(readFileSync(file, 'utf8'))) return dirname(picked);
  } catch {
    // no SKILL.md there: keep the folder as picked
  }
  return picked;
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Writes `<skillsDir>/cais/SKILL.md` from `source`, the skill file that ships with the app.
 * Never follows or replaces a link, never overwrites a SKILL.md that is not Cais's own (`name: cais` in the frontmatter),
 * and never touches anything else in the folder. All paths are parameters so tests use a temp directory
 * (never the real `~/.claude`).
 */
export function installSkill(opts: { source: string; skillsDir: string; /** Test hook: replaces `fs.linkSync`. */ link?: (existing: string, created: string) => void }): SkillInstallResult {
  const link = opts.link ?? linkSync;
  const t = m().mainMisc.skillInstall;
  const caisDir = join(opts.skillsDir, 'cais');
  const file = join(caisDir, 'SKILL.md');
  const refuse = (message: string): SkillInstallResult => ({ ok: false, status: 'refused', message, path: file });

  let content: string;
  try {
    content = readFileSync(opts.source, 'utf8');
  } catch {
    return { ok: false, status: 'refused', message: t.sourceMissing };
  }
  if (!isCaisSkill(content)) return { ok: false, status: 'refused', message: t.sourceMissing };

  let tmp: string | undefined;
  try {
    mkdirSync(opts.skillsDir, { recursive: true });
    const dirStat = lstatOrNull(caisDir);
    if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) return refuse(t.notDirectory({ path: caisDir }));
    if (!dirStat) mkdirSync(caisDir);

    const fileStat = lstatOrNull(file);
    let status: SkillInstallStatus = 'installed';
    if (fileStat) {
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) return refuse(t.notFile({ path: file }));
      if (fileStat.size > MAX_EXISTING_BYTES) return refuse(t.notOurFile({ path: file }));
      const existing = readFileSync(file, 'utf8');
      if (!isCaisSkill(existing)) return refuse(t.notOurFile({ path: file }));
      if (existing === content) return { ok: true, status: 'unchanged', message: t.alreadyUpToDate({ path: file }), path: file };
      status = 'updated';
    }

    // temp file in the same folder, flushed to disk, then moved into place: a reader never sees half a file
    tmp = join(caisDir, `.SKILL.md.${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o644);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o644);
    if (status === 'installed') {
      // a fresh install must never replace a SKILL.md that appeared after the check: link() fails instead of clobbering
      try {
        link(tmp, file);
        unlinkSync(tmp);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EOPNOTSUPP') {
          // no hard links here (exFAT/FAT, some SMB/9p shares): create SKILL.md itself, still exclusively
          try {
            const out = openSync(file, 'wx', 0o644);
            try {
              writeFileSync(out, content);
              fsyncSync(out);
            } finally {
              closeSync(out);
            }
          } catch (inner) {
            if ((inner as NodeJS.ErrnoException).code !== 'EEXIST') throw inner;
            unlinkSync(tmp);
            tmp = undefined;
            return refuse(t.notOurFile({ path: file }));
          }
          unlinkSync(tmp);
        } else if (code === 'EEXIST') {
          unlinkSync(tmp);
          tmp = undefined;
          return refuse(t.notOurFile({ path: file }));
        } else {
          throw error;
        }
      }
    } else {
      renameSync(tmp, file);
    }
    tmp = undefined;
    return { ok: true, status, message: status === 'updated' ? t.updated({ path: file }) : t.installed({ path: file }), path: file };
  } catch (error) {
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
        ? t.noPermission
        : code === 'EEXIST' || code === 'ENOTDIR'
          ? t.notDirectory({ path: opts.skillsDir })
          : (code ?? String((error as Error).message));
    return { ok: false, status: 'refused', message: t.failed({ path: file, reason }), path: file };
  }
}
