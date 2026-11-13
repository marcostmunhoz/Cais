/**
 * Renderer i18n. Imported first by main.tsx, so the locale is set before any component renders.
 * The locale comes from main through the preload (`window.cais.locale`); the renderer never picks one.
 */
import { isLocale, setLocale } from '@shared/i18n';

const locale = isLocale(window.cais.locale) ? window.cais.locale : 'pt-BR';
setLocale(locale);
document.documentElement.lang = locale;

export { fmt, getLocale, m, ref, render, renderRef, type MessageRef, type Messages } from '@shared/i18n';
