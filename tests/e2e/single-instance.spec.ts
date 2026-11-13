import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, root, seedUserData, shortTempDir } from './helpers';

test('a second Cais on the same user data quits by itself and the first keeps working', async () => {
  const userData = shortTempDir('cais-si-');
  seedUserData(userData);
  const { app, page } = await launch(userData);
  try {
    await expect(page.getByTestId('env-dev')).toBeVisible();
    const electronBin = resolve(root, 'node_modules/.bin/electron');
    const second = spawn(electronBin, [root], { env: { ...process.env, CAIS_E2E: '1', CAIS_USER_DATA: userData }, stdio: 'ignore' });
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => {
        second.kill('SIGKILL');
        done(-999);
      }, 20_000);
      second.on('exit', (c) => {
        clearTimeout(timer);
        done(c);
      });
    });
    expect(code).toBe(0);
    await expect(page.getByTestId('env-dev')).toBeVisible();
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
  }
});
