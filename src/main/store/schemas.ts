import { z } from 'zod';

const id = z.string().min(1);

const environmentBase = {
  id,
  projectId: id,
  name: z.string(),
  defaultDatabase: z.string().optional(),
  credentialId: id,
  production: z.boolean(),
  agentLevel: z.enum(['approve-all', 'free-reads', 'free-reads-writes']).optional(),
};

export const catalogSchema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({ id, name: z.string(), order: z.number() })),
  environments: z.array(
    z.discriminatedUnion('engine', [
      z.object({ ...environmentBase, engine: z.literal('mysql'), host: z.string(), port: z.number().int() }),
      z.object({
        ...environmentBase,
        engine: z.literal('bigquery'),
        gcpProject: z.string().min(1),
        maxBytesBilled: z.number().int().positive().optional(),
      }),
    ]),
  ),
  credentials: z.array(
    z.discriminatedUnion('kind', [
      z.object({ id, name: z.string(), kind: z.literal('password'), username: z.string() }),
      z.object({
        id,
        name: z.string(),
        kind: z.literal('gcloud-iam'),
        account: z.string(),
        impersonateServiceAccount: z.string().optional(),
        dbUsername: z.string(),
      }),
    ]),
  ),
});

export const secretsSchema = z.record(z.string(), z.string());

export const tabsSchema = z.object({
  version: z.literal(1),
  tabs: z.array(
    z.object({
      id,
      environmentId: z.string(),
      sql: z.string(),
      database: z.string().nullable().optional(),
      scriptId: z.string().optional(),
    }),
  ),
  activeTabId: z.string().nullable(),
});

export const scriptsSchema = z.object({
  version: z.literal(1),
  scripts: z.array(
    z.object({
      id,
      projectId: id,
      name: z.string(),
      sql: z.string(),
      database: z.string().optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
      createdBy: z.enum(['user', 'agent']),
      lastRun: z.object({ environmentId: z.string(), at: z.number() }).optional(),
    }),
  ),
});

export const settingsSchema = z.object({
  version: z.literal(1),
  agentAccess: z.boolean(),
  /** Optional: a settings.json written before it existed has none (off). Not part of the seal: it gives agents nothing. */
  estimateAsYouType: z.boolean().optional(),
});
