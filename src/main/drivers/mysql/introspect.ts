import type { SchemaColumn, SchemaTree } from '@shared/results';
import type mysql from 'mysql2';
import { query } from './connection';

const SQL = `
SELECT s.SCHEMA_NAME AS db, t.TABLE_NAME AS tbl, t.TABLE_TYPE AS ttype, t.ENGINE AS eng,
       c.COLUMN_NAME AS col, c.COLUMN_TYPE AS ctype, c.IS_NULLABLE AS nullable, c.COLUMN_KEY AS ckey,
       c.EXTRA AS extra
FROM information_schema.SCHEMATA s
LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
LEFT JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
WHERE s.SCHEMA_NAME NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')
ORDER BY s.SCHEMA_NAME, t.TABLE_NAME, c.ORDINAL_POSITION`;

const SYSTEM = "('mysql', 'sys', 'performance_schema', 'information_schema')";
const VIEW_USAGE = `SELECT VIEW_SCHEMA, VIEW_NAME, TABLE_SCHEMA, TABLE_NAME FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA NOT IN ${SYSTEM}`;
const ROUTINES = `SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ${SYSTEM}`;
const CASCADES = `SELECT UNIQUE_CONSTRAINT_SCHEMA, REFERENCED_TABLE_NAME, CONSTRAINT_SCHEMA, TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA NOT IN ${SYSTEM} AND (DELETE_RULE NOT IN ('RESTRICT', 'NO ACTION') OR UPDATE_RULE NOT IN ('RESTRICT', 'NO ACTION'))`;
const TRIGGERS = `SELECT EVENT_OBJECT_SCHEMA, EVENT_OBJECT_TABLE, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA NOT IN ${SYSTEM}`;

const text = (v: unknown): string | null => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/**
 * Whether a database name matches the name of a database-level grant as SCHEMA_PRIVILEGES shows it: "_" and "%"
 * are wildcards unless escaped with a backslash ("app\_db" is exactly app_db).
 */
export function grantMatches(pattern: string, name: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      re += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    } else if (c === '_') re += '.';
    else if (c === '%') re += '.*';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(name);
}

/** InnoDB's own list of foreign keys: not filtered by what the account may see (needs PROCESS). Names are "db/table". */
const INNODB_FOREIGN = 'SELECT FOR_NAME, REF_NAME, TYPE FROM information_schema.INNODB_FOREIGN';
/** TYPE bits of INNODB_FOREIGN that change other rows: ON DELETE CASCADE / SET NULL, ON UPDATE CASCADE / SET NULL. */
const CASCADING_TYPE = 1 | 2 | 4 | 8;

/** "db/table" of INNODB_FOREIGN (special characters as @xxxx) to "db.table". */
function innodbName(raw: string): string {
  return raw.replace(/@([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace('/', '.').toLowerCase();
}

/** The account's own grants (SHOW GRANTS needs no privilege): global table privileges and partial revokes. */
async function ownGrants(conn: mysql.Connection): Promise<{ globalTablePrivileges: boolean; revokes: { privileges: string; db: string }[] }> {
  const { rows } = await query(conn, 'SHOW GRANTS');
  let globalTablePrivileges = false;
  const revokes: { privileges: string; db: string }[] = [];
  for (const r of rows as unknown[][]) {
    const line = text(r[0]) ?? '';
    const grant = /^GRANT (.+?) ON \*\.\* TO /i.exec(line);
    if (grant && !/^USAGE$/i.test(grant[1]!.trim()) && /\b(ALL PRIVILEGES|SELECT|INSERT|UPDATE|DELETE|REFERENCES|INDEX|ALTER|CREATE|DROP|TRIGGER|SHOW VIEW)\b/i.test(grant[1]!)) {
      globalTablePrivileges = true;
    }
    const revoke = /^REVOKE (.+?) ON `((?:[^`]|``)+)`\.\* FROM /i.exec(line);
    if (revoke) revokes.push({ privileges: revoke[1]!, db: revoke[2]!.replace(/``/g, '`') });
    else if (/^REVOKE /i.test(line)) revokes.push({ privileges: 'ALL PRIVILEGES', db: '%' });
  }
  return { globalTablePrivileges, revokes };
}

/** Whether the current account holds TRIGGER globally, and in which databases. */
async function triggerVisibility(conn: mysql.Connection): Promise<{ global: boolean; schemas: string[] }> {
  const { rows: who } = await query(conn, 'SELECT CURRENT_USER()');
  const current = text((who[0] as unknown[] | undefined)?.[0]) ?? '';
  const at = current.lastIndexOf('@');
  const grantee = `'${current.slice(0, at)}'@'${current.slice(at + 1)}'`;
  const quoted = conn.escape(grantee);
  const { rows: global } = await query(conn, `SELECT 1 FROM information_schema.USER_PRIVILEGES WHERE PRIVILEGE_TYPE = 'TRIGGER' AND GRANTEE = ${quoted}`);
  const { rows: schemas } = await query(conn, `SELECT TABLE_SCHEMA FROM information_schema.SCHEMA_PRIVILEGES WHERE PRIVILEGE_TYPE = 'TRIGGER' AND GRANTEE = ${quoted}`);
  return { global: global.length > 0, schemas: (schemas as unknown[][]).map((r) => text(r[0]) ?? '') };
}

/** What COLUMNS.EXTRA says about a column ("VIRTUAL GENERATED", "DEFAULT_GENERATED on update CURRENT_TIMESTAMP"…). */
export function extraFacts(extra: string | null): Pick<SchemaColumn, 'generated' | 'onUpdate'> {
  const text = (extra ?? '').toUpperCase();
  return {
    ...(/\bVIRTUAL GENERATED\b/.test(text) ? { generated: 'virtual' as const } : /\bSTORED GENERATED\b/.test(text) ? { generated: 'stored' as const } : {}),
    ...(/\bON UPDATE\b/.test(text) ? { onUpdate: true } : {}),
  };
}

export async function readSchema(conn: mysql.Connection): Promise<SchemaTree> {
  const { rows } = await query(conn, SQL);
  // what a write can reach beyond the named table; best effort (older servers or missing privileges: nothing)
  // a query that fails marks the tree partial: whoever relies on it (an automatic commit) must not
  let partial = false;
  const optional = (sql: string) =>
    query(conn, sql).catch(() => {
      partial = true;
      return { rows: [] as unknown[] };
    });
  const views = await optional(VIEW_USAGE);
  const triggers = await optional(TRIGGERS);
  const routines = await optional(ROUTINES);
  const cascades = await optional(CASCADES);
  // TRIGGERS only lists what this account may see (TRIGGER privilege): record where it is blind
  const visibility = await triggerVisibility(conn).catch(() => null);
  const grants = await ownGrants(conn).catch(() => null);
  // with partial_revokes a global TRIGGER can be taken away per database: those databases are blind
  const triggerRevoked = (db: string): boolean =>
    grants === null || grants.revokes.some((r) => /\b(ALL PRIVILEGES|TRIGGER)\b/i.test(r.privileges) && (r.db === '%' || grantMatches(r.db, db)));
  // REFERENTIAL_CONSTRAINTS hides a foreign key whose child table the account cannot see, but InnoDB still
  // cascades into it. Complete only from InnoDB's own list, or with global privileges and no partial revoke.
  const innodb = await query(conn, INNODB_FOREIGN).catch(() => null);
  const foreignKeysComplete = innodb !== null || (grants !== null && grants.globalTablePrivileges && grants.revokes.length === 0);
  const dbs = new Map<string, Map<string, SchemaTree['databases'][number]['tables'][number]>>();
  for (const row of rows as unknown[][]) {
    const [db, tbl, ttype, eng, col, ctype, nullable, ckey, extra] = row.map((v) =>
      v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v),
    );
    if (db === null) continue;
    let tables = dbs.get(db);
    if (!tables) {
      tables = new Map();
      dbs.set(db, tables);
    }
    if (tbl === null) continue;
    let table = tables.get(tbl);
    if (!table) {
      table = { name: tbl, type: ttype === 'VIEW' ? 'view' : 'table', ...(eng ? { engine: eng } : {}), columns: [] };
      tables.set(tbl, table);
    }
    if (col !== null) {
      const column: SchemaColumn = { name: col, type: ctype ?? '', nullable: nullable === 'YES' };
      if (ckey === 'PRI' || ckey === 'UNI' || ckey === 'MUL') column.key = ckey;
      Object.assign(column, extraFacts(extra));
      table.columns.push(column);
    }
  }
  for (const row of views.rows as unknown[][]) {
    const [vdb, vname, tdb, tname] = row.map(text);
    const view = vdb && vname ? dbs.get(vdb)?.get(vname) : undefined;
    if (view && tdb && tname) (view.uses ??= []).push(`${tdb}.${tname}`.toLowerCase());
  }
  for (const row of triggers.rows as unknown[][]) {
    const [db, tbl, body] = row.map(text);
    const table = db && tbl ? dbs.get(db)?.get(tbl) : undefined;
    if (table && body) (table.triggers ??= []).push(body);
  }
  for (const row of cascades.rows as unknown[][]) {
    const [pdb, ptbl, cdb, ctbl] = row.map(text);
    const parent = pdb && ptbl ? dbs.get(pdb)?.get(ptbl) : undefined;
    if (parent && cdb && ctbl) (parent.cascadedBy ??= []).push(`${cdb}.${ctbl}`.toLowerCase());
  }
  for (const row of (innodb?.rows ?? []) as unknown[][]) {
    const [child, parentName, type] = row.map(text);
    if (!child || !parentName || !(Number(type) & CASCADING_TYPE)) continue;
    const [pdb, ptbl] = innodbName(parentName).split('.');
    const parent = [...dbs.entries()].find(([name]) => name.toLowerCase() === pdb)?.[1];
    const table = parent ? [...parent.values()].find((t) => t.name.toLowerCase() === ptbl) : undefined;
    const name = innodbName(child);
    if (table && !(table.cascadedBy ?? []).includes(name)) (table.cascadedBy ??= []).push(name);
  }
  const routinesByDb = new Map<string, { name: string; body: string | null }[]>();
  for (const row of routines.rows as unknown[][]) {
    const [db, name, body] = row.map(text);
    if (!db || !name) continue;
    const list = routinesByDb.get(db) ?? [];
    list.push({ name, body });
    routinesByDb.set(db, list);
  }
  return {
    foreignKeysComplete,
    databases: [...dbs.entries()].map(([name, tables]) => ({
      name,
      tables: [...tables.values()],
      ...(routinesByDb.has(name) ? { routines: routinesByDb.get(name)! } : {}),
      triggersVisible:
        visibility === null || triggerRevoked(name) ? false : visibility.global || visibility.schemas.some((p) => grantMatches(p, name)),
      ...(partial ? { partial: true } : {}),
    })),
  };
}
