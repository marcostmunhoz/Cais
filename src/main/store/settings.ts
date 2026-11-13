import { join } from 'node:path';
import { m } from '@shared/i18n';
import { loadValidated, writeFileAtomic } from './atomic';
import { settingsSchema } from './schemas';
import { Seal } from './seal';

export interface Settings {
  version: 1;
  agentAccess: boolean;
}

/** settings.json: the one switch the person owns. Agent access starts off. */
export class SettingsStore {
  private value: Settings = { version: 1, agentAccess: false };
  private readonly path: string;
  /** Message (app locale) when settings.json was unreadable and set aside, or changed outside the Cais. */
  notice: string | undefined;
  /** The switch was found on without the seal's signature and was turned off (for the trail). */
  tampered = false;

  constructor(
    dir: string,
    /** Integrity seal: an "on" nobody signed counts as off. Absent in tests that do not exercise it. */
    private readonly seal?: Seal,
  ) {
    this.path = join(dir, 'settings.json');
  }

  private macOf(value: Settings): string | undefined {
    return this.seal?.mac(`settings:${value.agentAccess ? 'on' : 'off'}`);
  }

  async load(): Promise<void> {
    const loaded = await loadValidated<Settings>(this.path, settingsSchema);
    this.value = loaded.value ?? { version: 1, agentAccess: false };
    this.notice = loaded.notice;
    this.tampered = false;
    if (this.seal && this.value.agentAccess && !Seal.same(this.macOf(this.value), this.seal.settingsMac())) {
      // turned on by hand (or the seal is new): only the person turns it on, in the app
      this.tampered = true;
      this.value = { ...this.value, agentAccess: false };
      await writeFileAtomic(this.path, JSON.stringify(this.value, null, 2));
      this.notice = m().mainMisc.store.agentAccessTampered;
    }
    await this.signCurrent();
  }

  private async signCurrent(): Promise<void> {
    const mac = this.macOf(this.value);
    if (mac && this.seal) await this.seal.setSettings(mac);
  }

  get agentAccess(): boolean {
    return this.value.agentAccess;
  }

  async setAgentAccess(enabled: boolean): Promise<void> {
    this.value = { ...this.value, agentAccess: enabled };
    // sign first: a crash between the two writes leaves "off" or a signed "on", never an unsigned "on" that counts
    await this.signCurrent();
    await writeFileAtomic(this.path, JSON.stringify(this.value, null, 2));
  }
}
