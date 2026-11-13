import { AGENT_LOCALE, messagesFor, type Locale } from '@shared/i18n';

/**
 * Error text that goes to an agent must not carry the server address or the database login:
 * "Sem resposta de 10.0.0.5:3306", "Access denied for user 'app'@'10.0.0.9'", ...
 * The placeholders are in AGENT_LOCALE (pt-BR) unless the text is for the person (`locale`).
 */
export function redactForAgent(text: string, target: { host: string; port: number }, locale: Locale = AGENT_LOCALE): string {
  const { server, user } = messagesFor(locale).agentsUi.redact;
  let out = text;
  const host = target.host.trim();
  if (host) {
    out = out.split(`${host}:${target.port}`).join(server);
    out = out.split(host).join(server);
  }
  out = out.replace(/'[^']*'@'[^']*'/g, () => `'${user}'@'${server}'`);
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, () => server);
  return out;
}
