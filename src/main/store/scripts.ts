import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MAX_SCRIPT_NAME, type Environment, type Project, type SavedScript, type ScriptSaveInput, type ScriptsFile } from '@shared/model';
import { duplicateName } from '@shared/scripts';
import { stripInvisible } from '@shared/text';
import { m, ref } from '@shared/i18n';
import { CaisError } from '../errors';
import { loadValidated, writeFileAtomic } from './atomic';
import { scriptsSchema } from './schemas';

export interface ScriptStoreDeps {
  getProject(id: string): Project | undefined;
  getEnvironment(id: string): Environment | undefined;
  now(): number;
}

/** Names compare NFC-normalized and case-insensitive. */
const foldName = (name: string): string => name.normalize('NFC').toLowerCase();

/** scripts.json. Scripts belong to a project; names are unique per project, ignoring case. */
export class ScriptStore {
  private scripts: SavedScript[] = [];
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  /** Message (app locale) when scripts.json was unreadable at startup and set aside, or has inconsistent scripts. */
  notice: string | undefined;

  constructor(
    dir: string,
    private readonly deps: ScriptStoreDeps,
  ) {
    this.path = join(dir, 'scripts.json');
  }

  async load(): Promise<void> {
    const loaded = await loadValidated<ScriptsFile>(this.path, scriptsSchema, this.deps.now);
    this.scripts = loaded.value?.scripts ?? [];
    this.notice = loaded.notice ?? this.inconsistency();
    this.loaded = true;
  }

  /** Duplicate names inside a project or scripts of a project that no longer exists: kept, but the person is told. */
  private inconsistency(): string | undefined {
    const seen = new Set<string>();
    let duplicates = 0;
    let orphans = 0;
    for (const s of this.scripts) {
      if (!this.deps.getProject(s.projectId)) orphans++;
      const key = `${s.projectId}\u0000${foldName(s.name)}`;
      if (seen.has(key)) duplicates++;
      seen.add(key);
    }
    if (duplicates === 0 && orphans === 0) return undefined;
    return m().mainScripts.inconsistent({ duplicates, orphans });
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (!this.loaded) await this.load();
      return fn();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private persist(): Promise<void> {
    const file: ScriptsFile = { version: 1, scripts: this.scripts };
    return writeFileAtomic(this.path, JSON.stringify(file, null, 2));
  }

  list(): SavedScript[] {
    return structuredClone(this.scripts);
  }

  get(id: string): SavedScript | undefined {
    const found = this.scripts.find((s) => s.id === id);
    return found ? structuredClone(found) : undefined;
  }

  countForProject(projectId: string): number {
    return this.scripts.filter((s) => s.projectId === projectId).length;
  }

  private checkName(projectId: string, raw: string, ignoreId?: string): string {
    // bidi and invisible controls are removed (not rejected), then the name is NFC-normalized
    const name = stripInvisible(raw).normalize('NFC').trim();
    // errors here can reach an agent saving a script: each keeps its ref (rendered in pt-BR for agents)
    if (!name) throw CaisError.of(ref('mainScripts.nameRequired'));
    if (name.length > MAX_SCRIPT_NAME) throw CaisError.of(ref('mainScripts.nameTooLong', { max: MAX_SCRIPT_NAME }));
    if (this.isTaken(projectId, name, ignoreId)) {
      const project = this.deps.getProject(projectId);
      throw CaisError.of(
        project ? ref('mainScripts.nameTaken', { project: project.name }) : ref('mainScripts.nameTakenHere'),
        'duplicate-name',
      );
    }
    return name;
  }

  private isTaken(projectId: string, name: string, ignoreId?: string): boolean {
    const key = foldName(name);
    return this.scripts.some((s) => s.projectId === projectId && s.id !== ignoreId && foldName(s.name) === key);
  }

  private requireProject(projectId: string): Project {
    const project = this.deps.getProject(projectId);
    if (!project) throw CaisError.of(ref('mainScripts.projectNotFound'));
    return project;
  }

  private require(id: string): SavedScript {
    const found = this.scripts.find((s) => s.id === id);
    if (!found) throw CaisError.of(ref('mainScripts.notFound'), 'not-found');
    return found;
  }

  /**
   * Creates (no id) or updates (id) a script. A person saving clears the "agent" mark;
   * `by: 'agent'` only ever creates.
   */
  save(input: ScriptSaveInput, by: 'user' | 'agent' = 'user'): Promise<SavedScript> {
    return this.run(async () => {
      const now = this.deps.now();
      const database = input.database?.trim() || undefined;
      if (input.id) {
        if (by === 'agent') throw CaisError.of(ref('mainScripts.agentsCannotEdit'));
        const script = this.require(input.id);
        if (script.projectId !== input.projectId) throw CaisError.of(ref('mainScripts.otherProject'));
        script.name = this.checkName(script.projectId, input.name, script.id);
        script.sql = input.sql;
        if (database) script.database = database;
        else delete script.database;
        script.updatedAt = now;
        script.createdBy = 'user';
        await this.persist();
        return structuredClone(script);
      }
      this.requireProject(input.projectId);
      const script: SavedScript = {
        id: randomUUID(),
        projectId: input.projectId,
        name: this.checkName(input.projectId, input.name),
        sql: input.sql,
        ...(database ? { database } : {}),
        createdAt: now,
        updatedAt: now,
        createdBy: by,
      };
      this.scripts.push(script);
      await this.persist();
      return structuredClone(script);
    });
  }

  rename(id: string, name: string): Promise<SavedScript> {
    return this.run(async () => {
      const script = this.require(id);
      script.name = this.checkName(script.projectId, name, id);
      script.updatedAt = this.deps.now();
      script.createdBy = 'user';
      await this.persist();
      return structuredClone(script);
    });
  }

  duplicate(id: string): Promise<SavedScript> {
    return this.run(async () => {
      const source = this.require(id);
      const now = this.deps.now();
      const copy: SavedScript = {
        id: randomUUID(),
        projectId: source.projectId,
        name: duplicateName(source.name, (c) => this.isTaken(source.projectId, c), MAX_SCRIPT_NAME),
        sql: source.sql,
        ...(source.database ? { database: source.database } : {}),
        createdAt: now,
        updatedAt: now,
        // a copy of an agent's script is still the agent's SQL: the mark goes away only when the person saves it
        createdBy: source.createdBy,
      };
      this.scripts.push(copy);
      await this.persist();
      return structuredClone(copy);
    });
  }

  delete(id: string): Promise<void> {
    return this.run(async () => {
      this.require(id);
      this.scripts = this.scripts.filter((s) => s.id !== id);
      await this.persist();
    });
  }

  markRun(id: string, environmentId: string): Promise<SavedScript> {
    return this.run(async () => {
      const script = this.require(id);
      const env = this.deps.getEnvironment(environmentId);
      if (!env || env.projectId !== script.projectId) throw CaisError.of(ref('mainScripts.environmentNotInProject'));
      script.lastRun = { environmentId, at: this.deps.now() };
      await this.persist();
      return structuredClone(script);
    });
  }
}
