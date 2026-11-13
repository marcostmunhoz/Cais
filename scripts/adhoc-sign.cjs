// electron-builder afterSign hook (runs after the Electron fuses are flipped): ad-hoc signs the macOS bundle (no developer identity).
// Without it the edited bundle keeps a stale signature from the stock Electron binary and
// `codesign --verify` fails; Apple Silicon refuses to run binaries with a broken signature.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
