import { z } from 'zod';

const id = z.string().min(1);

export const catalogSchema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({ id, name: z.string(), order: z.number() })),
  environments: z.array(
    z.object({
      id,
      projectId: id,
      name: z.string(),
      engine: z.literal('mysql'),
      host: z.string(),
      port: z.number().int(),
      defaultDatabase: z.string().optional(),
      credentialId: id,
      production: z.boolean(),
      agentLevel: z.enum(['approve-all', 'free-reads', 'free-reads-writes']).optional(),
    }),
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
});
