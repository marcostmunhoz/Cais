/** The locales Cais ships. The person never picks one: it follows the system. */
export const LOCALES = ['pt-BR', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

/** Locale used for everything agents read (CLI output, guide, broker responses): fixed, never the app's. */
export const AGENT_LOCALE: Locale = 'pt-BR';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Picks the app locale from the system's preferred languages, in order: the first tag starting with `pt`
 * gives pt-BR, the first starting with `en` gives en (case-insensitive). Neither gives en.
 */
export function resolveLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const lower = tag.trim().toLowerCase();
    if (lower.startsWith('pt')) return 'pt-BR';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

/** Argument main passes to the renderer through `additionalArguments`. */
export const LOCALE_ARG = '--cais-locale=';

/**
 * Reads `--cais-locale=<locale>` from a process argv (the preload's). Absent, repeated with a different value,
 * or unknown gives the fallback: the renderer never trusts a locale it cannot check.
 */
export function parseLocaleArg(argv: readonly string[], fallback: Locale = 'pt-BR'): Locale {
  const values = argv.filter((arg) => arg.startsWith(LOCALE_ARG)).map((arg) => arg.slice(LOCALE_ARG.length));
  if (values.length === 0) return fallback;
  const first = values[0];
  if (!isLocale(first) || values.some((v) => v !== first)) return fallback;
  return first;
}
