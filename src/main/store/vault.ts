/** Encrypts and decrypts secrets. The real one wraps Electron's safeStorage (Keychain on macOS). */
export interface Vault {
  isAvailable(): boolean;
  /** Returns base64 of the encrypted value. */
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
  /** Platform the vault runs on; lets callers add platform-specific guidance to a refusal. */
  readonly platform?: NodeJS.Platform;
}

/** Test-only vault: reversible, no Keychain. Never used by the packaged app. */
export class FakeVault implements Vault {
  constructor(private readonly available = true) {}
  isAvailable(): boolean {
    return this.available;
  }
  encrypt(plain: string): string {
    return Buffer.from(`fake:${plain.split('').reverse().join('')}`, 'utf8').toString('base64');
  }
  decrypt(encrypted: string): string {
    const text = Buffer.from(encrypted, 'base64').toString('utf8');
    if (!text.startsWith('fake:')) throw new Error('Invalid fake vault payload');
    return text.slice(5).split('').reverse().join('');
  }
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: which Secret Service backend Chromium picked (`basic_text` and `unknown` are not real vaults). */
  getSelectedStorageBackend?(): string;
}

export class SafeStorageVault implements Vault {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    readonly platform: NodeJS.Platform = process.platform,
  ) {}
  isAvailable(): boolean {
    if (!this.safeStorage.isEncryptionAvailable()) return false;
    if (this.platform === 'linux') {
      // Without a keyring Chromium falls back to a hard-coded key: that is not a vault.
      const backend = this.safeStorage.getSelectedStorageBackend?.();
      if (backend === undefined || backend === 'basic_text' || backend === 'unknown') return false;
    }
    return true;
  }
  encrypt(plain: string): string {
    return this.safeStorage.encryptString(plain).toString('base64');
  }
  decrypt(encrypted: string): string {
    return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }
}
