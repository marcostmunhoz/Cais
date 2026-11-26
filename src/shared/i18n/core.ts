import type { Locale } from './locale';

export { AGENT_LOCALE, LOCALES, LOCALE_ARG, isLocale, parseLocaleArg, resolveLocale, type Locale } from './locale';

/** A catalog entry: plain text, or a function of one params object that returns text. */
export type MessageFn = (params: never) => string;

/**
 * The shape another locale must follow, derived from the pt-BR catalog: every string becomes `string`,
 * every function keeps its exact signature, objects recurse. Annotating the `en` catalog with it makes
 * `tsc` fail on a missing key, an extra key or a different parameter type.
 */
export type Shape<T> = T extends string
  ? string
  : T extends (params: infer P) => string
    ? (params: P) => string
    : T extends (...args: never[]) => unknown
      ? never
      : { [K in keyof T]: Shape<T[K]> };

export interface PluralForms {
  one: string;
  other: string;
}

/** Number and date formatting bound to one locale (Intl only, so it works in main, preload and renderer). */
export interface Format {
  readonly locale: Locale;
  formatNumber(n: number, options?: Intl.NumberFormatOptions): string;
  /** Date only, e.g. 12/11/2026 or 11/12/2026. */
  formatDate(value: Date | number): string;
  /** Time only, with seconds: 14:03:27 or 2:03:27 PM. */
  formatTime(value: Date | number): string;
  /** Date and time, with seconds. */
  formatDateTime(value: Date | number): string;
  /**
   * The plural form for `n` (Intl.PluralRules), without the number. Zero always takes `other`
   * ("0 linhas", "0 rows"), as Cais always wrote it. A `#` in the chosen form becomes the formatted number.
   */
  plural(n: number, forms: PluralForms): string;
  /** A size in bytes in binary units (1 GiB = 2^30 bytes): "512 B", "1,5 GiB", "2 TiB". */
  formatBytes(bytes: number): string;
  /** The formatted number followed by the plural form: "1 row", "1,234 rows" (en), "1 linha", "1.234 linhas" (pt-BR). */
  count(n: number, forms: PluralForms): string;
}

const formats = new Map<Locale, Format>();

export function createFormat(locale: Locale): Format {
  const cached = formats.get(locale);
  if (cached) return cached;
  const numbers = new Intl.NumberFormat(locale);
  const dates = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const times = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateTimes = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const rules = new Intl.PluralRules(locale);
  const formatNumber = (n: number, options?: Intl.NumberFormatOptions): string =>
    options ? new Intl.NumberFormat(locale, options).format(n) : numbers.format(n);
  const plural = (n: number, forms: PluralForms): string => {
    const form = n !== 0 && rules.select(n) === 'one' ? forms.one : forms.other;
    return form.includes('#') ? form.replaceAll('#', formatNumber(n)) : form;
  };
  const formatBytes = (bytes: number): string => {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let unit = 0;
    let value = Math.max(0, bytes);
    while (unit < units.length - 1 && value >= 1024) {
      value /= 1024;
      unit++;
    }
    // two decimals can round 1023.999 up to 1024: that is the next unit
    if (unit < units.length - 1 && Math.round(value * 100) / 100 >= 1024) {
      value /= 1024;
      unit++;
    }
    return `${formatNumber(value, { maximumFractionDigits: unit === 0 ? 0 : 2 })} ${units[unit]}`;
  };
  const format: Format = {
    locale,
    formatNumber,
    formatBytes,
    formatDate: (value) => dates.format(value),
    formatTime: (value) => times.format(value),
    formatDateTime: (value) => dateTimes.format(value),
    plural,
    count: (n, forms) => `${formatNumber(n)} ${plural(n, forms)}`,
  };
  formats.set(locale, format);
  return format;
}
