// Names of projects and environments. Pure TypeScript.
import { stripInvisible } from './text';

/** Longest project or environment name main accepts (the IPC limit). */
export const MAX_CATALOG_NAME = 200;

/** What a name is stored as: no invisible or direction characters, NFC, trimmed. */
export function cleanName(text: string): string {
  return stripInvisible(text).normalize('NFC').trim();
}

/** What uniqueness compares: the clean name in NFC, ignoring case. */
export function nameKey(text: string): string {
  return cleanName(text).toLowerCase();
}

/** Same name for uniqueness purposes. */
export function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

/**
 * Whether `next` may be stored as a project or environment name: a "/" makes the agents' `projeto/ambiente`
 * address ambiguous, so it is refused in a new or changed name; an old name with "/" keeps working while
 * nobody changes it (`current` is the stored name, when there is one).
 */
export function slashAllowed(next: string, current?: string): boolean {
  const clean = cleanName(next);
  if (!clean.includes('/')) return true;
  return current !== undefined && cleanName(current) === clean;
}
