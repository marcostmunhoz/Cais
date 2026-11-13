import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import {
  AGENT_LEVEL_LABEL,
  agentLevelOf,
  agentLevelsFor,
  deriveIamUsernameFor,
  looksLikeProduction,
  type AgentLevel,
  type Credential,
  type Environment,
} from '@shared/model';
import { AUTO_COMMIT_MAX_ROWS } from '@shared/agents';
import type { GcloudAccount } from '@shared/ipc';
import { MAX_CATALOG_NAME, sameName } from '@shared/names';
import { duplicateName } from '@shared/scripts';
import { reloadCatalog, renameProject } from '../lib/actions';
import { m } from '../lib/i18n';
import { setState, useStore } from '../lib/store';
import { Modal } from './ui';
import { errorMessage } from '../lib/errors';

const errorText = errorMessage;

/** What a level lets agents do outside production, in the current locale. */
function agentLevelHint(level: AgentLevel): string {
  const hint = m().registry.levelHint;
  return level === 'free-reads-writes' ? hint['free-reads-writes']({ count: AUTO_COMMIT_MAX_ROWS }) : hint[level];
}

// --- credential form ---------------------------------------------------------

function CredentialForm({
  credentialId,
  onSaved,
  onDeleted,
  notice = false,
  onDirty,
}: {
  credentialId: string;
  onSaved: (c: Credential) => void;
  onDeleted?: () => void;
  /** "Salvo" survives the remount that follows saving a new item. */
  notice?: boolean;
  onDirty?: () => void;
}) {
  const catalog = useStore((s) => s.catalog);
  const existing = catalog.credentials.find((c) => c.id === credentialId);
  const hasSecret = catalog.credentialsWithSecret.includes(credentialId);
  const usedBy = catalog.environments.filter((e) => e.credentialId === credentialId).length;

  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<'password' | 'gcloud-iam'>(existing?.kind ?? 'password');
  const [username, setUsername] = useState(existing?.kind === 'password' ? existing.username : '');
  const [password, setPassword] = useState('');
  const [account, setAccount] = useState(existing?.kind === 'gcloud-iam' ? existing.account : '');
  const [sa, setSa] = useState(existing?.kind === 'gcloud-iam' ? (existing.impersonateServiceAccount ?? '') : '');
  const [dbUser, setDbUser] = useState(existing?.kind === 'gcloud-iam' ? existing.dbUsername : '');
  const [dbUserTouched, setDbUserTouched] = useState(!!existing && existing.kind === 'gcloud-iam');
  const [accounts, setAccounts] = useState<GcloudAccount[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (kind !== 'gcloud-iam' || accounts.length > 0 || accountsError) return;
    window.cais.catalog
      .gcloudAccounts()
      .then(setAccounts)
      .catch((e) => setAccountsError(errorText(e)));
  }, [kind, accounts.length, accountsError]);

  useEffect(() => {
    if (kind === 'gcloud-iam' && !dbUserTouched && account) setDbUser(deriveIamUsernameFor(account, sa));
  }, [account, sa, kind, dbUserTouched]);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const base = { ...(existing ? { id: existing.id } : {}), name };
      const saved: Credential =
        kind === 'password'
          ? await window.cais.catalog.saveCredential({
              ...base,
              kind,
              username,
              ...(password ? { password } : {}),
            })
          : await window.cais.catalog.saveCredential({
              ...base,
              kind,
              account,
              dbUsername: dbUser,
              ...(sa.trim() ? { impersonateServiceAccount: sa.trim() } : {}),
            });
      setPassword('');
      await reloadCatalog();
      onSaved(saved);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await window.cais.catalog.deleteCredential(credentialId);
      await reloadCatalog();
      onDeleted?.();
    } catch (e) {
      setError(errorText(e));
      setConfirmDelete(false);
    }
  };

  const t = m().registry;
  const c = t.credential;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onChange={() => onDirty?.()}
    >
      <div className="field">
        <label htmlFor="cred-name">{c.name}</label>
        <input id="cred-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={c.namePlaceholder} />
      </div>
      <div className="field">
        <span className="label">{c.kind}</span>
        <div className="seg" role="radiogroup" aria-label={c.kindLabel} style={{ alignSelf: 'flex-start' }}>
          <button type="button" role="radio" aria-checked={kind === 'password'} className={kind === 'password' ? 'on' : ''} onClick={() => setKind('password')}>
            {c.password}
          </button>
          <button type="button" role="radio" aria-checked={kind === 'gcloud-iam'} className={kind === 'gcloud-iam' ? 'on' : ''} onClick={() => setKind('gcloud-iam')}>
            {c.iam}
          </button>
        </div>
      </div>
      {kind === 'password' ? (
        <>
          <div className="field">
            <label htmlFor="cred-user">{c.username}</label>
            <input id="cred-user" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="cred-pass">{c.secret}</label>
            <input
              id="cred-pass"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasSecret ? c.secretKeep : ''}
              autoComplete="new-password"
            />
            <span className="hint">{c.secretHint}</span>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="cred-account">{c.account}</label>
            <input
              id="cred-account"
              className="input"
              list="gcloud-accounts"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder={c.accountPlaceholder}
              autoComplete="off"
            />
            <datalist id="gcloud-accounts">
              {accounts.map((a) => (
                <option key={a.account} value={a.account} />
              ))}
            </datalist>
            {accountsError && <span className="hint">{accountsError}</span>}
          </div>
          <div className="field">
            <label htmlFor="cred-sa">{c.impersonate}</label>
            <input id="cred-sa" className="input" value={sa} onChange={(e) => setSa(e.target.value)} placeholder={c.impersonatePlaceholder} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="cred-dbuser">{c.dbUser}</label>
            <input
              id="cred-dbuser"
              className="input"
              value={dbUser}
              onChange={(e) => {
                setDbUser(e.target.value);
                setDbUserTouched(true);
              }}
              autoComplete="off"
            />
            <span className="hint">{c.dbUserHint}</span>
          </div>
        </>
      )}
      {existing && <div className="hint" style={{ marginBottom: 10 }}>{c.usedBy({ count: usedBy })}</div>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className="btn accent" type="submit" disabled={busy}>
          {t.save}
        </button>
        {existing &&
          (confirmDelete ? (
            <>
              <button className="btn danger" type="button" onClick={() => void remove()}>
                {t.confirmDelete}
              </button>
              <button className="btn ghost" type="button" onClick={() => setConfirmDelete(false)}>
                {t.cancel}
              </button>
            </>
          ) : (
            <button className="btn ghost" type="button" onClick={() => setConfirmDelete(true)}>
              {t.delete}
            </button>
          ))}
        {notice && <span className="form-ok">{t.saved}</span>}
      </div>
    </form>
  );
}

// --- environment form --------------------------------------------------------

const NEW_PROJECT = '__new_project__';
const NEW_CREDENTIAL = '__new_credential__';

function EnvironmentForm({
  environmentId,
  presetProjectId,
  duplicateOf,
  onSaved,
  onDeleted,
  onDuplicate,
  notice = false,
  onDirty,
}: {
  environmentId: string;
  presetProjectId?: string;
  /** A new environment prefilled from this one: saving it is the person's check of the copy. */
  duplicateOf?: string;
  onSaved: (env: Environment) => void;
  onDeleted: () => void;
  onDuplicate: (sourceId: string) => void;
  notice?: boolean;
  onDirty?: () => void;
}) {
  const catalog = useStore((s) => s.catalog);
  const existing = catalog.environments.find((e) => e.id === environmentId);
  // what the fields start from: the environment being edited, or the one being duplicated
  const source = existing ?? (duplicateOf ? catalog.environments.find((e) => e.id === duplicateOf) : undefined);
  const sourceProject = source ? catalog.projects.find((p) => p.id === source.projectId) : undefined;
  const initialName = (): string => {
    if (existing || !source) return existing?.name ?? '';
    const siblings = catalog.environments.filter((e) => e.projectId === source.projectId);
    return duplicateName(source.name, (candidate) => siblings.some((e) => sameName(e.name, candidate)), MAX_CATALOG_NAME);
  };

  const [projectId, setProjectId] = useState(
    source?.projectId ?? presetProjectId ?? catalog.projects[0]?.id ?? NEW_PROJECT,
  );
  const [newProject, setNewProject] = useState('');
  const [name, setName] = useState(initialName);
  const [host, setHost] = useState(source?.host ?? '');
  const [port, setPort] = useState(String(source?.port ?? 3306));
  const [database, setDatabase] = useState(source?.defaultDatabase ?? '');
  const [credentialId, setCredentialId] = useState(source?.credentialId ?? catalog.credentials[0]?.id ?? '');
  const [production, setProductionState] = useState(source?.production ?? false);
  const [productionTouched, setProductionTouched] = useState(!!source);
  const [agentLevel, setAgentLevel] = useState<AgentLevel>(source ? agentLevelOf(source) : 'free-reads');
  // becoming production starts at "Tudo com aprovação": free reads there is the person's explicit choice. Leaving
  // production (the name "pro" on the way to "proxy", or the box unchecked) gives back the level from before.
  const [levelOutside, setLevelOutside] = useState<AgentLevel | null>(null);
  const setProduction = (next: boolean): void => {
    if (next && !production) {
      setLevelOutside(agentLevel);
      setAgentLevel('approve-all');
    } else if (!next && production && levelOutside) {
      setAgentLevel(levelOutside);
      setLevelOutside(null);
    }
    setProductionState(next);
  };
  const levels = agentLevelsFor(production);
  const shownLevel: AgentLevel = catalog.agentLevelsLocked ? 'approve-all' : levels.includes(agentLevel) ? agentLevel : 'approve-all';
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [credDialog, setCredDialog] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const credentialIds = useMemo(() => new Set(catalog.credentials.map((c) => c.id)), [catalog.credentials]);
  useEffect(() => {
    if (!credentialIds.has(credentialId) && catalog.credentials[0]) setCredentialId(catalog.credentials[0].id);
  }, [credentialIds, credentialId, catalog.credentials]);

  const onName = (value: string) => {
    setName(value);
    if (!productionTouched) setProduction(looksLikeProduction(value));
  };

  const draftPort = Number(port);
  const validPort = Number.isInteger(draftPort) && draftPort > 0 && draftPort < 65536;

  const test = async () => {
    setTestResult(null);
    if (!host.trim() || !validPort || !credentialIds.has(credentialId)) {
      setTestResult({ ok: false, text: m().registry.environment.testMissing });
      return;
    }
    setTesting(true);
    try {
      const res = await window.cais.connection.test({
        engine: 'mysql',
        host: host.trim(),
        port: draftPort,
        ...(database.trim() ? { defaultDatabase: database.trim() } : {}),
        credentialId,
      });
      setTestResult(
        res.ok ? { ok: true, text: m().registry.environment.connected({ version: res.serverVersion }) } : { ok: false, text: res.error },
      );
    } catch (e) {
      setTestResult({ ok: false, text: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!validPort) {
      setError(m().registry.environment.invalidPort);
      return;
    }
    try {
      let pid = projectId;
      if (pid === NEW_PROJECT) {
        const wanted = newProject.trim();
        const same = catalog.projects.find((p) => sameName(p.name, wanted));
        pid = same ? same.id : (await window.cais.catalog.saveProject({ name: wanted })).id;
      }
      const env = await window.cais.catalog.saveEnvironment({
        ...(existing ? { id: existing.id } : {}),
        projectId: pid,
        name,
        engine: 'mysql',
        host,
        port: draftPort,
        ...(database.trim() ? { defaultDatabase: database.trim() } : {}),
        credentialId,
        production,
        // production never lets agents write by themselves; main enforces it too
        agentLevel: shownLevel,
      });
      await reloadCatalog();
      setProjectId(pid);
      onSaved(env);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const remove = async () => {
    try {
      await window.cais.catalog.deleteEnvironment(environmentId);
      await reloadCatalog();
      onDeleted();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const t = m().registry;
  const v = t.environment;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onChange={() => onDirty?.()}
    >
      {!existing && source && (
        <p className="hint" data-testid="env-duplicate-of" style={{ marginBottom: 10 }}>
          {t.duplicateOf({ source: `${sourceProject?.name ?? '?'}/${source.name}` })}
        </p>
      )}
      <div className="field">
        <label htmlFor="env-project">{v.project}</label>
        <select id="env-project" className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {catalog.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value={NEW_PROJECT}>{v.newProject}</option>
        </select>
        {projectId === NEW_PROJECT && (
          <input
            className="input"
            aria-label={v.newProjectLabel}
            placeholder={v.newProjectPlaceholder}
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            autoFocus
          />
        )}
      </div>
      <div className="field">
        <label htmlFor="env-name">{v.name}</label>
        <input id="env-name" className="input" value={name} onChange={(e) => onName(e.target.value)} placeholder={v.namePlaceholder} autoComplete="off" />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="env-host">{v.host}</label>
          <input id="env-host" className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5" autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="env-port">{v.port}</label>
          <input id="env-port" className="input" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="env-db">{v.database}</label>
        <input id="env-db" className="input" value={database} onChange={(e) => setDatabase(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="env-cred">{v.credential}</label>
        <select
          id="env-cred"
          className="input"
          value={credentialId}
          onChange={(e) => {
            if (e.target.value === NEW_CREDENTIAL) setCredDialog(true);
            else setCredentialId(e.target.value);
          }}
        >
          {catalog.credentials.length === 0 && <option value="">{v.noCredential}</option>}
          {catalog.credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value={NEW_CREDENTIAL}>{v.newCredential}</option>
        </select>
      </div>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={production}
            onChange={(e) => {
              setProduction(e.target.checked);
              setProductionTouched(true);
            }}
          />
          {v.production}
        </label>
        <span className="hint">{v.productionHint}</span>
      </div>
      <div className="field">
        <label htmlFor="env-agents">{v.agents}</label>
        <select
          id="env-agents"
          className="input"
          data-testid="env-agent-level"
          value={shownLevel}
          disabled={catalog.agentLevelsLocked}
          onChange={(e) => setAgentLevel(e.target.value as AgentLevel)}
        >
          {levels.map((level) => (
            <option key={level} value={level}>
              {AGENT_LEVEL_LABEL[level]}
            </option>
          ))}
        </select>
        <span className="hint" data-testid="env-agent-hint">
          {catalog.agentLevelsLocked
            ? t.levelHint.locked
            : production
              ? shownLevel === 'free-reads'
                ? t.levelHint.productionFreeReads
                : t.levelHint.productionApproveAll
              : agentLevelHint(shownLevel)}
        </span>
      </div>
      {!existing && source && catalog.blockedEnvironments.includes(source.id) && (
        <p className="form-error" role="alert" data-testid="env-duplicate-blocked">
          {t.duplicateSourceBlocked}
        </p>
      )}
      {existing && catalog.blockedEnvironments.includes(existing.id) && (
        <p className="form-error" role="alert" data-testid="env-blocked">
          {v.blocked}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {testResult && (
        <p className={testResult.ok ? 'form-ok' : 'form-error'} role="status" data-testid="test-result">
          {testResult.text}
        </p>
      )}
      <div className="form-actions">
        <button className="btn accent" type="submit">
          {t.save}
        </button>
        <button className="btn" type="button" disabled={testing} onClick={() => void test()}>
          {testing ? v.testing : v.test}
        </button>
        {existing && (
          <button className="btn" type="button" title={t.duplicateTitle} onClick={() => onDuplicate(existing.id)}>
            {t.duplicate}
          </button>
        )}
        {existing &&
          (confirmDelete ? (
            <>
              <button className="btn danger" type="button" onClick={() => void remove()}>
                {t.confirmDelete}
              </button>
              <button className="btn ghost" type="button" onClick={() => setConfirmDelete(false)}>
                {t.cancel}
              </button>
            </>
          ) : (
            <button className="btn ghost" type="button" onClick={() => setConfirmDelete(true)}>
              {t.delete}
            </button>
          ))}
        {notice && <span className="form-ok">{t.saved}</span>}
      </div>
      {credDialog && (
        <Modal title={t.newCredential} onClose={() => setCredDialog(false)} align="center">
          <div className="dialog-head">
            <h2>{t.newCredential}</h2>
            <button className="icon-btn" aria-label={t.close} onClick={() => setCredDialog(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="dialog-body" style={{ width: 420 }}>
            <CredentialForm
              credentialId="new"
              onSaved={(c) => {
                setCredentialId(c.id);
                setCredDialog(false);
              }}
            />
          </div>
        </Modal>
      )}
    </form>
  );
}

// --- dialog ------------------------------------------------------------------

export function RegistryDialog() {
  const request = useStore((s) => s.registry);
  const catalog = useStore((s) => s.catalog);
  const [section, setSection] = useState<'environments' | 'credentials'>('environments');
  const [editId, setEditId] = useState<string | undefined>();
  const [duplicateOf, setDuplicateOf] = useState<string | undefined>();
  const [notice, setNotice] = useState(false);

  useEffect(() => {
    if (request) {
      setSection(request.section);
      setNotice(false);
      setEditId(request.editId ?? (request.section === 'credentials' ? undefined : 'new'));
      setDuplicateOf(request.duplicateOf);
    }
  }, [request]);
  const edit = (id: string | undefined): void => {
    setNotice(false);
    setDuplicateOf(undefined);
    setEditId(id);
  };

  if (!request) return null;
  const close = () => setState({ registry: null });
  const projects = [...catalog.projects].sort((a, b) => a.order - b.order);
  const t = m().registry;

  return (
    <Modal title={t.dialogTitle} onClose={close} className="registry">
      <div className="dialog-head">
        <div className="section-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={section === 'environments'}
            className={section === 'environments' ? 'on' : ''}
            onClick={() => {
              setSection('environments');
              edit(undefined);
            }}
          >
            {t.sections.environments}
          </button>
          <button
            role="tab"
            aria-selected={section === 'credentials'}
            className={section === 'credentials' ? 'on' : ''}
            onClick={() => {
              setSection('credentials');
              edit(undefined);
            }}
          >
            {t.sections.credentials}
          </button>
        </div>
        <button className="icon-btn" aria-label={t.close} onClick={close}>
          <X size={14} />
        </button>
      </div>
      <div className="registry-body">
        <div className="registry-list">
          <button className="btn small" style={{ width: '100%', justifyContent: 'center' }} onClick={() => edit('new')}>
            <Plus size={12} /> {section === 'environments' ? t.newEnvironment : t.newCredential}
          </button>
          {section === 'environments' &&
            projects.map((p) => (
              <div key={p.id}>
                <div className="group" data-testid={`registry-project-${p.name}`}>
                  <span className="label">{p.name}</span>
                  <button
                    className="icon-btn group-action"
                    aria-label={t.renameProject({ name: p.name })}
                    title={t.renameProjectTitle}
                    onClick={() => renameProject(p.id)}
                  >
                    <Pencil size={11} />
                  </button>
                </div>
                {catalog.environments
                  .filter((e) => e.projectId === p.id)
                  .map((e) => (
                    <div
                      key={e.id}
                      role="button"
                      tabIndex={0}
                      className={`tree-row ${editId === e.id ? 'active' : ''}`}
                      onClick={() => edit(e.id)}
                      onKeyDown={(ev) => ev.key === 'Enter' && edit(e.id)}
                    >
                      <span className={`dot ${e.production ? 'prod' : ''}`} />
                      <span className="label">{e.name}</span>
                      {catalog.blockedEnvironments.includes(e.id) ? (
                        <span className="detail">{t.row.blocked}</span>
                      ) : (
                        agentLevelOf(e) !== 'approve-all' &&
                        (agentLevelOf(e) === 'free-reads-writes' || e.production) && (
                          <span className="detail">{agentLevelOf(e) === 'free-reads-writes' ? t.row.freeWrites : t.row.freeReads}</span>
                        )
                      )}
                    </div>
                  ))}
              </div>
            ))}
          {section === 'credentials' &&
            catalog.credentials.map((c) => (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                className={`tree-row ${editId === c.id ? 'active' : ''}`}
                onClick={() => edit(c.id)}
                onKeyDown={(ev) => ev.key === 'Enter' && edit(c.id)}
              >
                <span className="label">{c.name}</span>
                <span className="detail">{c.kind === 'password' ? t.row.password : t.row.iam}</span>
              </div>
            ))}
        </div>
        <div className="registry-form">
          {editId === undefined ? (
            <div className="placeholder" style={{ height: '100%' }}>
              {section === 'environments' ? t.pickEnvironment : t.pickCredential}
            </div>
          ) : section === 'environments' ? (
            <EnvironmentForm
              key={`${editId}:${duplicateOf ?? ''}`}
              environmentId={editId}
              presetProjectId={request.projectId}
              duplicateOf={editId === 'new' ? duplicateOf : undefined}
              notice={notice}
              onDirty={() => setNotice(false)}
              onSaved={(env) => {
                setNotice(true);
                setDuplicateOf(undefined);
                setEditId(env.id);
              }}
              onDeleted={() => edit(undefined)}
              onDuplicate={(sourceId) => {
                setNotice(false);
                setDuplicateOf(sourceId);
                setEditId('new');
              }}
            />
          ) : (
            <CredentialForm
              key={editId}
              credentialId={editId}
              notice={notice}
              onDirty={() => setNotice(false)}
              onSaved={(c) => {
                setNotice(true);
                setEditId(c.id);
              }}
              onDeleted={() => edit(undefined)}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
