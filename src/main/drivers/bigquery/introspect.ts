import type { SchemaColumn, SchemaTable, SchemaTree } from '@shared/results';
import { datasetList, tableGet, tableList, type BigqueryClient } from './client';
import { typeText } from './values';

const CONCURRENCY = 8;
const PAGE = 1000;

/** Runs `fn` over `items` with at most CONCURRENCY in flight, keeping the order of the results. */
async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

function tableKind(type: string | undefined): Pick<SchemaTable, 'type' | 'subtype'> {
  switch (type) {
    case 'VIEW':
      return { type: 'view' };
    case 'MATERIALIZED_VIEW':
      return { type: 'view', subtype: 'materialized-view' };
    case 'EXTERNAL':
      return { type: 'table', subtype: 'external' };
    case 'SNAPSHOT':
      return { type: 'table', subtype: 'snapshot' };
    default:
      return { type: 'table' };
  }
}

export async function listDatasets(client: BigqueryClient, project: string): Promise<string[]> {
  const names: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.call(datasetList, 'GET', `/projects/${encodeURIComponent(project)}/datasets`, {
      query: { maxResults: PAGE, pageToken },
    });
    for (const d of page.datasets ?? []) names.push(d.datasetReference.datasetId);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return names;
}

async function listTables(client: BigqueryClient, project: string, dataset: string): Promise<{ id: string; type?: string }[]> {
  const tables: { id: string; type?: string }[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.call(tableList, 'GET', `/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(dataset)}/tables`, {
      query: { maxResults: PAGE, pageToken },
    });
    for (const t of page.tables ?? []) tables.push({ id: t.tableReference.tableId, ...(t.type ? { type: t.type } : {}) });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return tables;
}

/**
 * Datasets and their tables and views; with `scope.database`, also the columns of that dataset (tables.get per
 * table, free of charge, a few at a time). A dataset whose tables cannot be listed comes back empty and `partial`;
 * when none can be listed the first error is thrown (the account has no access at all, or the network is down).
 */
export async function readSchema(client: BigqueryClient, project: string, scope: { database?: string } = {}): Promise<SchemaTree> {
  const names = (await listDatasets(client, project)).sort((a, b) => a.localeCompare(b));
  const failures: unknown[] = [];
  const databases = await mapLimited(names, async (name) => {
    try {
      const listed = (await listTables(client, project, name)).sort((a, b) => a.id.localeCompare(b.id));
      const wantColumns = scope.database !== undefined && scope.database.toLowerCase() === name.toLowerCase();
      let partial = false;
      const tables = await mapLimited(listed, async (t): Promise<SchemaTable> => {
        let columns: SchemaColumn[] = [];
        if (wantColumns) {
          try {
            const full = await client.call(tableGet, 'GET', `/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(name)}/tables/${encodeURIComponent(t.id)}`);
            columns = (full.schema?.fields ?? []).map((f) => ({ name: f.name ?? '', type: typeText(f), nullable: f.mode?.toUpperCase() !== 'REQUIRED' }));
          } catch (error) {
            failures.push(error);
            partial = true;
          }
        }
        return { name: t.id, ...tableKind(t.type), columns };
      });
      return { name, tables, ...(partial ? { partial: true } : {}) };
    } catch (error) {
      failures.push(error);
      return { name, tables: [], partial: true };
    }
  });
  if (names.length > 0 && failures.length > 0 && databases.every((d) => d.tables.length === 0 && d.partial)) throw failures[0];
  return { databases };
}
