import type { AgentsSnapshot } from '@shared/agents';
import { m } from '@shared/i18n';
import { CaisError } from '../errors';
import type { SettingsStore } from '../store/settings';
import { AgentError } from './errors';
import type { AgentBroker } from './broker';
import type { AgentServer } from './server';

/** The on/off switch: the server (and its socket) exists only while this is on. */
export class AgentAccess {
  private startError: string | undefined;

  constructor(
    private readonly deps: { settings: SettingsStore; broker: AgentBroker; server: AgentServer; onChange(): void },
  ) {}

  /** At launch: honors the saved switch. A socket that cannot open leaves access off and says why. */
  async init(): Promise<void> {
    if (!this.deps.settings.agentAccess) return;
    try {
      await this.turnOn();
    } catch (error) {
      this.startError = describe(error);
      this.deps.broker.setEnabled(false);
    }
  }

  private async turnOn(): Promise<void> {
    await this.deps.server.start();
    this.deps.broker.setEnabled(true);
    this.startError = undefined;
  }

  async set(enabled: boolean): Promise<void> {
    if (enabled) {
      if (this.deps.broker.isEnabled()) return;
      try {
        await this.turnOn();
      } catch (error) {
        await this.deps.server.stop().catch(() => undefined);
        throw new CaisError(describe(error));
      }
      await this.deps.settings.setAgentAccess(true);
    } else {
      // off at once: nothing in flight may pass an "enabled" check while the files are written
      this.deps.broker.setEnabled(false);
      // also when the broker is already off (a failed start): the saved switch must go back to off
      if (this.deps.settings.agentAccess) await this.deps.settings.setAgentAccess(false);
      this.startError = undefined;
      await this.deps.server.stop();
      await this.deps.broker.disable();
    }
    this.deps.onChange();
  }

  snapshot(): AgentsSnapshot {
    return { ...this.deps.broker.snapshot(), ...(this.startError ? { startError: this.startError } : {}) };
  }

  /** The app is quitting. */
  async shutdown(): Promise<void> {
    await this.deps.server.stop().catch(() => undefined);
    await this.deps.broker.shutdown();
  }
}

/** Shown to the person (panel, toast): in the app locale. */
function describe(error: unknown): string {
  if (error instanceof AgentError || error instanceof CaisError) return error.message;
  const msg = m().agentsUi.error;
  return msg.socketFailed({ code: (error as NodeJS.ErrnoException).code ?? msg.unknownError });
}
