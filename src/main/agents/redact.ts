import { AGENT_LOCALE, messagesFor, type Locale } from '@shared/i18n';

/** Where an environment connects to: a MySQL server, or a Google Cloud project. */
export type RedactTarget = { host: string; port: number } | { gcpProject: string };

/**
 * Error text that goes to an agent must not carry the server address or the database login:
 * "Sem resposta de 10.0.0.5:3306", "Access denied for user 'app'@'10.0.0.9'", ...
 * BigQuery: the project id and the e-mail of any account (the person's or a service account).
 * The placeholders are in AGENT_LOCALE (pt-BR) unless the text is for the person (`locale`).
 */
export function redactForAgent(text: string, target: RedactTarget, locale: Locale = AGENT_LOCALE): string {
  const { server, user, project, account } = messagesFor(locale).agentsUi.redact;
  let out = text;
  if ('gcpProject' in target) {
    // e-mails first: a service account's domain carries the project id (`sa@my-project.iam.gserviceaccount.com`)
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => account);
    const id = target.gcpProject.trim();
    if (id) out = out.split(id).join(project);
    // the project's name inside a domain-scoped id too ("example.com:my-project")
    const bare = id.includes(':') ? id.slice(id.indexOf(':') + 1) : '';
    if (bare) out = out.split(bare).join(project);
    return out;
  }
  const host = target.host.trim();
  if (host) {
    out = out.split(`${host}:${target.port}`).join(server);
    out = out.split(host).join(server);
  }
  out = out.replace(/'[^']*'@'[^']*'/g, () => `'${user}'@'${server}'`);
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, () => server);
  return out;
}
