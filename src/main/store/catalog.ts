import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { m, ref } from '@shared/i18n';
import { sameTarget } from '@shared/engines';
import { cleanName, sameName, slashAllowed } from '@shared/names';
import {
  AGENT_LEVEL_LABEL,
  type AgentLevel,
  type Catalog,
  type CatalogSnapshot,
  type Credential,
  type CredentialInput,
  type Environment,
  type EnvironmentInput,
  type Project,
  type ProjectInput,
} from '@shared/model';
import { CaisError } from '../errors';
import { loadValidated, writeFileAtomic } from './atomic';
import { catalogSchema, secretsSchema } from './schemas';
import { environmentSealText, Seal } from './seal';
import type { Vault } from './vault';

type Secrets = Record<string, string>;

const emptyCatalog = (): Catalog => ({ version: 1, projects: [], environments: [], credentials: [] });

/** catalog.json + secrets.json. Passwords only ever enter here (save) and leave through `getPassword` (main only). */
export class CatalogStore {
  private catalog: Catalog = emptyCatalog();
  private secrets: Secrets = {};
  private loaded = false;
  private notices: string[] = [];
  private scriptCounter: (projectId: string) => number = () => 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** What the integrity check found at load (app locale), for the trail. */
  integrityNotes: string[] = [];
  /** Environments that did not match the seal: nothing connects to them until the person saves them again. */
  private readonly blocked = new Set<string>();
  /** Blocked because the seal was missing (nothing known to be wrong): signed as such, so a restart is not an alarm. */
  private readonly pending = new Set<string>();
  /** No system vault: every level counts as approve-all, without touching what is on disk. */
  private vaultless = false;

  private readonly catalogPath: string;
  private readonly secretsPath: string;

  constructor(
    dir: string,
    private readonly vault: Vault,
    /** Integrity seal of the environments. Absent in tests that do not exercise it. */
    private readonly seal?: Seal,
  ) {
    this.catalogPath = join(dir, 'catalog.json');
    this.secretsPath = join(dir, 'secrets.json');
  }

  /** Lets the project guard know how many saved scripts a project owns. */
  setScriptCounter(fn: (projectId: string) => number): void {
    this.scriptCounter = fn;
  }

  addNotice(message: string): void {
    this.notices.push(message);
  }

  projects(): Project[] {
    return structuredClone(this.catalog.projects);
  }

  environments(): Environment[] {
    return this.catalog.environments.map((e) => this.effective(e));
  }

  /** What the rest of the app sees of an environment: without the vault, never a looser level than approve-all. */
  private effective(env: Environment): Environment {
    const copy = structuredClone(env);
    if (this.vaultless) copy.agentLevel = 'approve-all';
    return copy;
  }

  getProject(id: string): Project | undefined {
    return this.catalog.projects.find((p) => p.id === id);
  }

  async load(): Promise<void> {
    const catalog = await loadValidated<Catalog>(this.catalogPath, catalogSchema);
    const secrets = await loadValidated<Secrets>(this.secretsPath, secretsSchema);
    this.catalog = catalog.value ?? emptyCatalog();
    this.secrets = secrets.value ?? {};
    this.notices = [catalog.notice, secrets.notice].filter((n): n is string => !!n);
    this.loaded = true;
    await this.checkIntegrity();
  }

  /** What the seal covers for one environment: the environment itself, its credential and that credential's stored secret. */
  private sealText(env: Environment): string {
    const credential = this.catalog.credentials.find((c) => c.id === env.credentialId) ?? null;
    const project = this.getProject(env.projectId)?.name ?? null;
    return environmentSealText({ env, project }, credential, this.secrets[env.credentialId] ?? null);
  }

  private async reseal(): Promise<void> {
    if (!this.seal?.available) return;
    const envs: Record<string, string> = {};
    // a blocked environment is never signed: it stays blocked at the next start until the person saves it
    const pending: Record<string, string> = {};
    for (const env of this.catalog.environments) {
      if (!this.blocked.has(env.id)) envs[env.id] = this.seal.mac(this.sealText(env))!;
      else if (this.pending.has(env.id)) pending[env.id] = this.seal.mac(`pending:${env.id}`)!;
    }
    await this.seal.setEnvs(envs, pending);
  }

  /** Throws when the environment was changed outside the Cais and the person has not reviewed it yet. */
  requireTrusted(environmentId: string): void {
    if (this.blocked.has(environmentId)) {
      throw CaisError.of(ref('mainCatalog.environmentUntrusted'), 'environment-untrusted');
    }
  }

  isBlocked(environmentId: string): boolean {
    return this.blocked.has(environmentId);
  }

  /**
   * An environment changed outside the Cais (catalog.json, secrets.json) cannot be trusted: it becomes
   * production with "Tudo com aprovação" and is blocked (no connection, by the person or by agents) until the
   * person reviews and saves it, because its host may now be someone else's and the Cais would send the
   * credential there. Without a seal (first start, seal.json removed, a key the vault cannot open) nobody knows
   * what changed: every environment is blocked the same way. Without the vault nothing can be signed: every
   * environment is "Tudo com aprovação" while it lasts (in memory only).
   */
  private async checkIntegrity(): Promise<void> {
    this.integrityNotes = [];
    const seal = this.seal;
    if (!seal) return;
    const envs = this.catalog.environments;
    const label = (e: Environment): string => `${this.getProject(e.projectId)?.name ?? '?'} · ${e.name}`;
    let changed = false;
    const approveAll = (e: Environment): void => {
      if (e.agentLevel !== 'approve-all') changed = true;
      e.agentLevel = 'approve-all';
    };
    this.blocked.clear();
    this.pending.clear();
    this.vaultless = !seal.available;
    if (!seal.available) return; // nothing to sign with: approve-all through effective(), the file untouched
    const integrity = m().mainCatalog.integrity;
    const approveAllLabel = AGENT_LEVEL_LABEL['approve-all'];
    if (seal.status === 'missing') {
      // nobody knows what changed (production may have been unchecked, the host pointed elsewhere): all blocked,
      // production and approve-all, until the person reviews each one
      for (const e of envs) {
        if (!e.production) changed = true;
        e.production = true;
        approveAll(e);
        this.blocked.add(e.id);
        this.pending.add(e.id);
      }
      if (envs.length > 0) {
        const note = integrity.sealCreated({ count: envs.length, names: envs.map(label).join(', '), approveAll: approveAllLabel });
        this.notices.push(note);
        this.integrityNotes.push(note);
      }
    } else {
      // still waiting from a start without seal: blocked, but not an alarm. The pending mark covers the id only,
      // so what the file says now is as untrusted as at the start without seal: production and approve-all again,
      // or a hand edit (production off, free reads) would ride on the person's save
      const waiting = envs.filter((e) => seal.envMac(e.id) === undefined && Seal.same(seal.mac(`pending:${e.id}`), seal.pendingMac(e.id)));
      for (const e of waiting) {
        if (!e.production) changed = true;
        e.production = true;
        approveAll(e);
        this.blocked.add(e.id);
        this.pending.add(e.id);
      }
      if (waiting.length > 0) {
        this.notices.push(integrity.waiting({ count: waiting.length, names: waiting.map(label).join(', ') }));
      }
      const tampered = envs.filter((e) => !this.pending.has(e.id) && !Seal.same(seal.mac(this.sealText(e)), seal.envMac(e.id)));
      for (const e of tampered) {
        if (!e.production) changed = true;
        e.production = true;
        approveAll(e);
        this.blocked.add(e.id);
      }
      if (tampered.length > 0) {
        const note = integrity.tampered({ count: tampered.length, names: tampered.map(label).join(', '), approveAll: approveAllLabel });
        this.notices.push(note);
        this.integrityNotes.push(note);
      }
    }
    if (changed) await this.persistCatalog();
    else await this.reseal();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /** Serializes mutations so concurrent saves cannot interleave. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      await this.ensureLoaded();
      return fn();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async persistCatalog(): Promise<void> {
    await writeFileAtomic(this.catalogPath, JSON.stringify(this.catalog, null, 2));
    await this.reseal();
  }

  private async persistSecrets(): Promise<void> {
    await writeFileAtomic(this.secretsPath, JSON.stringify(this.secrets, null, 2));
    await this.reseal();
  }

  async snapshot(): Promise<CatalogSnapshot> {
    await this.ensureLoaded();
    return this.view();
  }

  private view(): CatalogSnapshot {
    const credentialsWithSecret = this.catalog.credentials
      .filter((c) => c.kind === 'password' && this.secrets[c.id] !== undefined)
      .map((c) => c.id);
    return structuredClone({
      ...this.catalog,
      environments: this.catalog.environments.map((e) => this.effective(e)),
      credentialsWithSecret,
      blockedEnvironments: [...this.blocked],
      ...(this.vaultless ? { agentLevelsLocked: true } : {}),
      notices: this.notices,
    });
  }

  getEnvironment(id: string): Environment | undefined {
    const env = this.catalog.environments.find((e) => e.id === id);
    return env ? this.effective(env) : undefined;
  }

  getCredential(id: string): Credential | undefined {
    return this.catalog.credentials.find((c) => c.id === id);
  }

  /** Main-process only: the password never goes back to the renderer. */
  getPassword(credentialId: string): string | undefined {
    const encrypted = this.secrets[credentialId];
    if (encrypted === undefined) return undefined;
    return this.vault.decrypt(encrypted);
  }

  saveProject(input: ProjectInput): Promise<Project> {
    return this.run(async () => {
      // with the id of a project that exists it is a rename (same rules as renameProject)
      if (input.id && this.getProject(input.id)) return (await this.renameUnqueued(input.id, input.name)).project;
      const name = this.projectName(input.name);
      const order = this.catalog.projects.reduce((max, p) => Math.max(max, p.order), -1) + 1;
      const project: Project = { id: input.id ?? randomUUID(), name, order };
      this.catalog.projects.push(project);
      await this.persistCatalog();
      return structuredClone(project);
    });
  }

  /**
   * Renames a project, refusing an unknown id. The seal covers the project name, so every trusted environment
   * of the project is signed again with the new one; a blocked environment stays blocked (only the person's save
   * of that environment releases it).
   */
  renameProject(id: string, name: string): Promise<{ project: Project; previousName: string }> {
    return this.run(() => this.renameUnqueued(id, name));
  }

  private async renameUnqueued(id: string, raw: string): Promise<{ project: Project; previousName: string }> {
    const project = this.getProject(id);
    if (!project) throw new CaisError(m().mainCatalog.projectNotFound, 'not-found');
    const name = this.projectName(raw, project);
    const previousName = project.name;
    if (name !== previousName) {
      project.name = name;
      await this.persistCatalog();
    }
    return { project: structuredClone(project), previousName };
  }

  /**
   * A new project with a copy of every environment of `id` (new ids, same credential, production and level
   * clamped as saveEnvironment does), in one write. Refused when an environment of the project is
   * blocked: the copy would be signed, laundering an environment changed outside the Cais. Scripts are not copied.
   */
  duplicateProject(id: string, newName: string): Promise<{ project: Project; copies: { source: Environment; copy: Environment }[] }> {
    return this.run(async () => {
      const source = this.getProject(id);
      if (!source) throw new CaisError(m().mainCatalog.projectNotFound, 'not-found');
      const envs = this.catalog.environments.filter((e) => e.projectId === id);
      const blocked = envs.filter((e) => this.blocked.has(e.id));
      if (blocked.length > 0) {
        throw new CaisError(
          m().mainCatalog.duplicateBlocked({ count: blocked.length, names: blocked.map((e) => `${source.name}/${e.name}`).join(', ') }),
          'environment-untrusted',
        );
      }
      const name = this.projectName(newName);
      const order = this.catalog.projects.reduce((max, p) => Math.max(max, p.order), -1) + 1;
      const project: Project = { id: randomUUID(), name, order };
      const copies = envs.map((src) => {
        const { agentLevel: _level, ...rest } = structuredClone(src);
        const level = this.clampLevel(src.production, src.agentLevel);
        const copy: Environment = { ...rest, id: randomUUID(), projectId: project.id, ...(level ? { agentLevel: level } : {}) };
        return { source: this.effective(src), copy };
      });
      this.catalog.projects.push(project);
      this.catalog.environments.push(...copies.map((c) => c.copy));
      await this.persistCatalog();
      return {
        project: structuredClone(project),
        copies: copies.map((c) => ({ source: c.source, copy: this.effective(c.copy) })),
      };
    });
  }

  /** A clean project name (trimmed, NFC, no invisible text), unique ignoring case, without "/" unless unchanged. */
  private projectName(raw: string, current?: Project): string {
    const name = cleanName(raw);
    if (!name) throw new CaisError(m().mainCatalog.projectNameRequired, 'invalid-name');
    if (!slashAllowed(name, current?.name)) throw new CaisError(m().mainCatalog.slashInName, 'invalid-name');
    if (this.catalog.projects.some((p) => p.id !== current?.id && sameName(p.name, name))) {
      throw new CaisError(m().mainCatalog.projectExists({ name }), 'duplicate-name');
    }
    return name;
  }

  /**
   * Production never lets agents write by themselves, whatever was asked: at most free reads;
   * without the vault, "Tudo com aprovação".
   */
  private clampLevel(production: boolean, level: AgentLevel | undefined): AgentLevel | undefined {
    const vaultless = !!this.seal && !this.seal.available;
    if (vaultless) return 'approve-all';
    if (production) return level === 'free-reads' ? 'free-reads' : 'approve-all';
    return level;
  }

  deleteProject(id: string): Promise<void> {
    return this.run(async () => {
      const envs = this.catalog.environments.filter((e) => e.projectId === id);
      if (envs.length > 0) {
        throw new CaisError(m().mainCatalog.projectHasEnvironments({ names: envs.map((e) => e.name).join(', ') }), 'in-use');
      }
      const scripts = this.scriptCounter(id);
      if (scripts > 0) {
        throw new CaisError(m().mainCatalog.projectHasScripts({ count: scripts }), 'in-use');
      }
      this.catalog.projects = this.catalog.projects.filter((p) => p.id !== id);
      await this.persistCatalog();
    });
  }

  saveEnvironment(input: EnvironmentInput): Promise<Environment> {
    return this.run(async () => {
      const name = cleanName(input.name);
      const host = input.host.trim();
      if (!name) throw new CaisError(m().mainCatalog.environmentNameRequired, 'invalid-name');
      if (!host) throw new CaisError(m().mainCatalog.hostRequired);
      if (!this.catalog.projects.some((p) => p.id === input.projectId)) {
        throw new CaisError(m().mainCatalog.projectNotFound, 'not-found');
      }
      if (!this.catalog.credentials.some((c) => c.id === input.credentialId)) {
        throw new CaisError(m().mainCatalog.credentialRequired);
      }
      const current = input.id ? this.catalog.environments.find((e) => e.id === input.id) : undefined;
      if (!slashAllowed(name, current?.name)) throw new CaisError(m().mainCatalog.slashInName, 'invalid-name');
      const duplicate = this.catalog.environments.find(
        (e) => e.id !== input.id && e.projectId === input.projectId && sameName(e.name, name),
      );
      if (duplicate) throw new CaisError(m().mainCatalog.environmentExists({ name }), 'duplicate-name');
      const agentLevel = this.clampLevel(input.production, input.agentLevel);
      const env: Environment = {
        id: input.id ?? randomUUID(),
        projectId: input.projectId,
        name,
        engine: input.engine,
        host,
        port: input.port,
        credentialId: input.credentialId,
        production: input.production,
        ...(input.defaultDatabase?.trim() ? { defaultDatabase: input.defaultDatabase.trim() } : {}),
        ...(agentLevel ? { agentLevel } : {}),
      };
      const index = this.catalog.environments.findIndex((e) => e.id === env.id);
      if (index === -1) this.catalog.environments.push(env);
      else this.catalog.environments[index] = env;
      // the person saved it from the form: reviewed, so it is trusted (and signed) again
      this.blocked.delete(env.id);
      this.pending.delete(env.id);
      await this.persistCatalog();
      return structuredClone(env);
    });
  }

  deleteEnvironment(id: string): Promise<void> {
    return this.run(async () => {
      this.catalog.environments = this.catalog.environments.filter((e) => e.id !== id);
      await this.persistCatalog();
    });
  }

  /** `password`: undefined or empty keeps the current one. */
  saveCredential(input: CredentialInput, password?: string): Promise<Credential> {
    return this.run(async () => {
      const name = input.name.trim();
      if (!name) throw new CaisError(m().mainCatalog.credentialNameRequired);
      const duplicate = this.catalog.credentials.find(
        (c) => c.id !== input.id && c.name.toLowerCase() === name.toLowerCase(),
      );
      if (duplicate) throw new CaisError(m().mainCatalog.credentialExists({ name }));

      const id = input.id ?? randomUUID();
      let credential: Credential;
      if (input.kind === 'password') {
        const username = input.username.trim();
        if (!username) throw new CaisError(m().mainCatalog.usernameRequired);
        const hasCurrent = this.secrets[id] !== undefined;
        if (!password && !hasCurrent) throw new CaisError(m().mainCatalog.passwordRequired);
        if (password) {
          if (!this.vault.isAvailable()) {
            const hint = this.vault.platform === 'linux' ? ` ${m().mainCatalog.vaultUnavailableLinuxHint}` : '';
            throw new CaisError(`${m().mainCatalog.vaultUnavailable}${hint}`, 'vault-unavailable');
          }
          this.secrets[id] = this.vault.encrypt(password);
          await this.persistSecrets();
        }
        credential = { id, name, kind: 'password', username };
      } else {
        const account = input.account.trim();
        const dbUsername = input.dbUsername.trim();
        if (!account) throw new CaisError(m().mainCatalog.gcloudAccountRequired);
        if (!dbUsername) throw new CaisError(m().mainCatalog.dbUsernameRequired);
        const sa = input.impersonateServiceAccount?.trim();
        credential = {
          id,
          name,
          kind: 'gcloud-iam',
          account,
          dbUsername,
          ...(sa ? { impersonateServiceAccount: sa } : {}),
        };
        if (this.secrets[id] !== undefined) {
          delete this.secrets[id];
          await this.persistSecrets();
        }
      }
      const index = this.catalog.credentials.findIndex((c) => c.id === id);
      if (index === -1) this.catalog.credentials.push(credential);
      else this.catalog.credentials[index] = credential;
      await this.persistCatalog();
      return structuredClone(credential);
    });
  }

  deleteCredential(id: string): Promise<void> {
    return this.run(async () => {
      const users = this.catalog.environments.filter((e) => e.credentialId === id);
      if (users.length > 0) {
        const projects = new Map(this.catalog.projects.map((p) => [p.id, p.name]));
        const list = users.map((e) => `${projects.get(e.projectId) ?? '?'} · ${e.name}`).join(', ');
        throw new CaisError(m().mainCatalog.credentialInUse({ names: list }), 'in-use', {
          environments: users.map((e) => e.id),
        });
      }
      this.catalog.credentials = this.catalog.credentials.filter((c) => c.id !== id);
      await this.persistCatalog();
      if (this.secrets[id] !== undefined) {
        delete this.secrets[id];
        await this.persistSecrets();
      }
    });
  }
}

/**
 * Whether saving an environment changed what an agent reaches or how it names it, so its 15-minute grant is
 * revoked and its pending requests expire: host, port, credential, default database, production, and its name
 * or project, because the `projeto/ambiente` slug changes and a pending request showing the old one would
 * mislead whoever approves it.
 */
export function changedForAgents(before: Environment, after: Environment): boolean {
  return (
    !sameTarget(before, after) ||
    before.defaultDatabase !== after.defaultDatabase ||
    before.production !== after.production ||
    before.name !== after.name ||
    before.projectId !== after.projectId
  );
}
