'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const tempRoot = fs.realpathSync(os.tmpdir());
const userData = fs.mkdtempSync(path.join(tempRoot, 'module-ui-audit-'));
const env = { ...process.env };
env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'; // Isolated data: test page, not the production renderer.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, 'audit-ui-electron.cjs'), userData], {
  env, stdio: 'inherit', windowsHide: true,
});
const timeout = setTimeout(() => { console.error('UI audit timed out'); child.kill(); }, 45000);
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timeout);
  if (!path.resolve(userData).startsWith(tempRoot + path.sep)) throw Error('Unsafe cleanup path');
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  process.exitCode = code ?? 1;
});
