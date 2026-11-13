import { app } from 'electron';
import { getLocale, isLocale, resolveLocale, setLocale, type Locale } from '@shared/i18n';

let resolved = false;

/**
 * Resolves the app locale once for the main process and makes it current for `m()`/`fmt()`.
 * The system's preferred languages decide; `CAIS_LOCALE` is a test hook honored only by an unpackaged app.
 * Safe to call more than once (the first call wins).
 */
export function initMainLocale(): Locale {
  if (resolved) return getLocale();
  const override = process.env.CAIS_LOCALE;
  let locale: Locale;
  if (!app.isPackaged && isLocale(override)) {
    locale = override;
  } else {
    let preferred: string[] = [];
    try {
      preferred = app.getPreferredSystemLanguages();
    } catch {
      preferred = [];
    }
    locale = resolveLocale(preferred);
  }
  setLocale(locale);
  resolved = true;
  return locale;
}

/** The locale main resolved (pt-BR until `initMainLocale` runs). */
export function mainLocale(): Locale {
  return getLocale();
}
