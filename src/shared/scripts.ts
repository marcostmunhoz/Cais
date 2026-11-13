// Pure helpers for saved scripts (shared by main and renderer).
import { getLocale, m } from './i18n';
import type { Environment, Project, SavedScript } from './model';

/** The tab text differs from the saved script: the tab shows the "•" marker. */
export function isScriptDirty(tabSql: string, script: Pick<SavedScript, 'sql'>): boolean {
  return tabSql !== script.sql;
}

/** Most recent use: the later of the last run and the last save. */
export function scriptRecency(script: Pick<SavedScript, 'updatedAt' | 'lastRun'>): number {
  return Math.max(script.updatedAt, script.lastRun?.at ?? 0);
}

/** Most recently used first; ties keep a stable alphabetical order (collation of the app locale). */
export function sortByRecency<T extends Pick<SavedScript, 'name' | 'updatedAt' | 'lastRun'>>(scripts: T[]): T[] {
  const locale = getLocale();
  return [...scripts].sort((a, b) => scriptRecency(b) - scriptRecency(a) || a.name.localeCompare(b.name, locale));
}

/**
 * Which environment Cmd+O opens a script in:
 * the active tab's environment when it is in the same project, else the environment of the last run,
 * else the first non-production environment, else the first environment of the project.
 */
export function pickEnvironmentForScript(
  script: Pick<SavedScript, 'projectId' | 'lastRun'>,
  environments: Environment[],
  activeEnvironmentId?: string | null,
): Environment | undefined {
  const own = environments.filter((e) => e.projectId === script.projectId);
  const active = own.find((e) => e.id === activeEnvironmentId);
  if (active) return active;
  const last = own.find((e) => e.id === script.lastRun?.environmentId);
  if (last) return last;
  return own.find((e) => !e.production) ?? own[0];
}

/** "Nome (cópia)", then "Nome (cópia 2)"... that is free (scripts, environments, projects). Suffix in the app locale. */
export function duplicateName(name: string, taken: (candidate: string) => boolean, maxLength = 120): string {
  const fit = (suffix: string): string => `${name.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
  const words = m().common;
  let candidate = fit(` ${words.copySuffix}`);
  for (let n = 2; taken(candidate); n++) candidate = fit(` ${words.copySuffixN({ n })}`);
  return candidate;
}

/** "há 2 dias" ("2 days ago"), in the app locale. */
export function formatAgo(from: number, now: number): string {
  const t = m().scripts.ago;
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  if (seconds < 60) return t.justNow;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t.minutes({ n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.hours({ n: hours });
  return t.days({ n: Math.floor(hours / 24) });
}

/** Tooltip text: "rodou em pro há 2 dias", or "ainda não rodou" (app locale). */
export function lastRunText(script: Pick<SavedScript, 'lastRun'>, environments: Environment[], now: number): string {
  const t = m().scripts;
  if (!script.lastRun) return t.neverRan;
  const env = environments.find((e) => e.id === script.lastRun!.environmentId);
  return t.ranIn({ environment: env?.name ?? t.removedEnvironment, ago: formatAgo(script.lastRun.at, now) });
}

export function projectName(projects: Project[], id: string): string {
  return projects.find((p) => p.id === id)?.name ?? '';
}
