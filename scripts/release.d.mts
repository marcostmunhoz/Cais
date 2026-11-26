export function parseVersion(text: string): number[] | null;
export function compareVersions(a: string, b: string): number;
export function latestVersion(tags: string[]): string | null;
export type PathDecision = { path: 'tag' | 'pr'; error?: undefined } | { error: string; path?: undefined };
export function decidePath(input: {
  version: string;
  packageVersion: string;
  latestTag: string | null;
  tagExists: boolean;
}): PathDecision;
export type CheckRun = { name: string; status: string; conclusion: string | null };
export type WorkflowRun = { status: string; conclusion: string | null };
export function evaluateCheck(
  checkRuns: CheckRun[] | undefined,
  workflowRuns: WorkflowRun[] | undefined,
): { state: 'ok' | 'pending' | 'failed' | 'missing'; reason: string };
export function main(argv: string[]): Promise<void>;
