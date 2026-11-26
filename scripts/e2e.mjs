// Runs the Playwright e2e suite. On Linux it runs under a virtual X display (xvfb-run) by itself, so the Electron
// windows never open on the desktop; the specs also force the X11 ozone platform and drop WAYLAND_DISPLAY.
import { spawn, spawnSync } from 'node:child_process';

const command = ['npx', 'playwright', 'test', '--config', 'tests/e2e/playwright.config.ts', ...process.argv.slice(2)];

let argv = command;
const env = { ...process.env };
// CI already wraps the whole check in xvfb-run, and CAIS_XVFB marks that we are already inside one.
if (process.platform === 'linux' && !env.CI && !env.CAIS_XVFB) {
  const found = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (found.error) {
    console.log('xvfb-run not found: e2e windows will open on the desktop. Install it (package: xvfb) to run headless.');
  } else {
    argv = ['xvfb-run', '-a', ...command];
    env.CAIS_XVFB = '1';
  }
}

const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
