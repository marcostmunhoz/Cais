import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { m } from '@shared/i18n';
import { installSkill, isCaisSkill, resolveSkillsDir } from '@main/skill-install';

const skill = (version: string) => `---\nname: cais\ndescription: Database access through Cais (${version}).\n---\n\n# Cais\n\nRules ${version}.\n`;

let dir: string;
let source: string;
let skillsDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cais-skill-'));
  source = join(dir, 'res', 'SKILL.md');
  mkdirSync(join(dir, 'res'));
  writeFileSync(source, skill('v2'));
  skillsDir = join(dir, 'home', '.claude', 'skills');
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

const target = () => join(skillsDir, 'cais', 'SKILL.md');

describe('isCaisSkill', () => {
  it('reads the name in the frontmatter, and only there', () => {
    expect(isCaisSkill(skill('x'))).toBe(true);
    expect(isCaisSkill('---\r\nname: "cais"\r\n---\r\nbody')).toBe(true);
    expect(isCaisSkill('---\nname: other\n---\n')).toBe(false);
    expect(isCaisSkill('---\nname: caisx\n---\n')).toBe(false);
    expect(isCaisSkill('# no frontmatter\nname: cais\n')).toBe(false);
    expect(isCaisSkill('---\ndescription: x\n---\nname: cais\n')).toBe(false);
  });
});

describe('installSkill', () => {
  it('installs into a folder that does not exist yet, creating the folders, with mode 0644 and no leftovers', () => {
    const out = installSkill({ source, skillsDir });
    expect(out).toMatchObject({ ok: true, status: 'installed', path: target() });
    expect(out.message).toContain(target());
    expect(readFileSync(target(), 'utf8')).toBe(skill('v2'));
    expect(statSync(target()).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(skillsDir, 'cais'))).toEqual(['SKILL.md']);
  });

  it.each(['EPERM', 'ENOTSUP', 'ENOSYS'])('installs by an exclusive create when the filesystem has no hard links (%s)', (code) => {
    const link = () => {
      throw Object.assign(new Error('no links'), { code });
    };
    const out = installSkill({ source, skillsDir, link });
    expect(out).toMatchObject({ ok: true, status: 'installed', path: target() });
    expect(readFileSync(target(), 'utf8')).toBe(skill('v2'));
    expect(statSync(target()).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(skillsDir, 'cais'))).toEqual(['SKILL.md']);
  });

  it('without hard links, a SKILL.md that appears in the meantime is not overwritten', () => {
    const link = () => {
      writeFileSync(target(), 'someone else');
      throw Object.assign(new Error('no links'), { code: 'EPERM' });
    };
    mkdirSync(join(skillsDir, 'cais'), { recursive: true });
    const out = installSkill({ source, skillsDir, link });
    expect(out).toMatchObject({ ok: false, status: 'refused' });
    expect(readFileSync(target(), 'utf8')).toBe('someone else');
    expect(readdirSync(join(skillsDir, 'cais'))).toEqual(['SKILL.md']);
  });

  it('updates an older skill of ours', () => {
    mkdirSync(join(skillsDir, 'cais'), { recursive: true });
    writeFileSync(target(), skill('v1'));
    expect(installSkill({ source, skillsDir })).toMatchObject({ ok: true, status: 'updated' });
    expect(readFileSync(target(), 'utf8')).toBe(skill('v2'));
    expect(readdirSync(join(skillsDir, 'cais'))).toEqual(['SKILL.md']);
  });

  it('says it is up to date and does not rewrite the file', () => {
    installSkill({ source, skillsDir });
    const before = statSync(target()).mtimeMs;
    const out = installSkill({ source, skillsDir });
    expect(out).toMatchObject({ ok: true, status: 'unchanged' });
    expect(out.message).toContain('já está atualizada');
    expect(statSync(target()).mtimeMs).toBe(before);
  });

  it('never touches other files and folders of the skills folder', () => {
    mkdirSync(join(skillsDir, 'other'), { recursive: true });
    writeFileSync(join(skillsDir, 'other', 'SKILL.md'), '---\nname: other\n---\n');
    mkdirSync(join(skillsDir, 'cais'));
    writeFileSync(join(skillsDir, 'cais', 'notes.txt'), 'mine');
    installSkill({ source, skillsDir });
    expect(readFileSync(join(skillsDir, 'other', 'SKILL.md'), 'utf8')).toBe('---\nname: other\n---\n');
    expect(readFileSync(join(skillsDir, 'cais', 'notes.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(join(skillsDir, 'cais')).sort()).toEqual(['SKILL.md', 'notes.txt']);
  });

  it('refuses a SKILL.md that is not ours and leaves it alone', () => {
    mkdirSync(join(skillsDir, 'cais'), { recursive: true });
    writeFileSync(target(), '---\nname: my-own-thing\n---\nhands off\n');
    const out = installSkill({ source, skillsDir });
    expect(out).toMatchObject({ ok: false, status: 'refused' });
    expect(out.message).toContain('não é um arquivo nosso');
    expect(readFileSync(target(), 'utf8')).toBe('---\nname: my-own-thing\n---\nhands off\n');
    writeFileSync(target(), 'no frontmatter at all');
    expect(installSkill({ source, skillsDir }).status).toBe('refused');
  });

  it('refuses a SKILL.md that is a symlink, even to our own skill', () => {
    mkdirSync(join(skillsDir, 'cais'), { recursive: true });
    const real = join(dir, 'real-skill.md');
    writeFileSync(real, skill('v1'));
    symlinkSync(real, target());
    expect(installSkill({ source, skillsDir })).toMatchObject({ ok: false, status: 'refused' });
    expect(lstatSync(target()).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe(skill('v1'));
  });

  it('refuses a cais folder that is a symlink', () => {
    mkdirSync(skillsDir, { recursive: true });
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(skillsDir, 'cais'));
    expect(installSkill({ source, skillsDir })).toMatchObject({ ok: false, status: 'refused' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a cais that is a file, and a SKILL.md that is a folder', () => {
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'cais'), 'a file');
    expect(installSkill({ source, skillsDir })).toMatchObject({ ok: false, status: 'refused' });
    expect(readFileSync(join(skillsDir, 'cais'), 'utf8')).toBe('a file');
    rmSync(join(skillsDir, 'cais'));
    mkdirSync(target(), { recursive: true });
    expect(installSkill({ source, skillsDir })).toMatchObject({ ok: false, status: 'refused' });
    expect(statSync(target()).isDirectory()).toBe(true);
  });

  it('follows a skills folder that is itself a link (dotfiles setups)', () => {
    const real = join(dir, 'dotfiles-skills');
    mkdirSync(real);
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
    symlinkSync(real, skillsDir);
    expect(installSkill({ source, skillsDir })).toMatchObject({ ok: true, status: 'installed' });
    expect(existsSync(join(real, 'cais', 'SKILL.md'))).toBe(true);
  });

  it('reports a folder it cannot write to, without leftovers', () => {
    if (process.getuid?.() === 0) return; // root ignores the permission bits
    mkdirSync(join(skillsDir, 'cais'), { recursive: true });
    chmodSync(join(skillsDir, 'cais'), 0o555);
    const out = installSkill({ source, skillsDir });
    chmodSync(join(skillsDir, 'cais'), 0o755);
    expect(out).toMatchObject({ ok: false, status: 'refused' });
    expect(out.message).toContain(m().mainMisc.skillInstall.noPermission);
    expect(out.message).not.toContain('EACCES');
    expect(readdirSync(join(skillsDir, 'cais'))).toEqual([]);
  });

  it('reports an unwritable parent (cannot create the skills folder)', () => {
    if (process.getuid?.() === 0) return;
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    const out = installSkill({ source, skillsDir: join(locked, 'skills') });
    chmodSync(locked, 0o755);
    expect(out).toMatchObject({ ok: false, status: 'refused' });
    expect(out.message).toContain('Não foi possível instalar a skill');
    expect(out.message).toContain(m().mainMisc.skillInstall.noPermission);
  });

  it('explains a skills folder that exists as a file', () => {
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(skillsDir.replace(/\/\.claude\/skills$/, '/.claude'), 'a file');
    const out = installSkill({ source, skillsDir });
    expect(out).toMatchObject({ ok: false, status: 'refused' });
    expect(out.message).not.toMatch(/ENOTDIR|EEXIST/);
  });

  it('refuses when the bundled file is missing or is not the Cais skill', () => {
    expect(installSkill({ source: join(dir, 'nope.md'), skillsDir })).toMatchObject({ ok: false, status: 'refused' });
    writeFileSync(source, '---\nname: other\n---\n');
    expect(installSkill({ source, skillsDir })).toMatchObject({ ok: false, status: 'refused' });
    expect(existsSync(skillsDir)).toBe(false);
  });
});

describe('resolveSkillsDir', () => {
  it('uses the parent when the picked folder is the installed cais skill folder', () => {
    installSkill({ source, skillsDir });
    expect(resolveSkillsDir(join(skillsDir, 'cais'))).toBe(skillsDir);
    expect(installSkill({ source, skillsDir: resolveSkillsDir(join(skillsDir, 'cais')) })).toMatchObject({ ok: true, status: 'unchanged' });
    expect(existsSync(join(skillsDir, 'cais', 'cais'))).toBe(false);
  });

  it('keeps a folder as picked when it is not a Cais skill folder', () => {
    expect(resolveSkillsDir(skillsDir)).toBe(skillsDir);
    mkdirSync(join(skillsDir, 'cais'), { recursive: true });
    expect(resolveSkillsDir(join(skillsDir, 'cais'))).toBe(join(skillsDir, 'cais'));
    writeFileSync(join(skillsDir, 'cais', 'SKILL.md'), '---\nname: other\n---\n');
    expect(resolveSkillsDir(join(skillsDir, 'cais'))).toBe(join(skillsDir, 'cais'));
  });
});
