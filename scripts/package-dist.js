const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const base = path.resolve(__dirname, '..');
const version = require(path.join(base, 'package.json')).version;
const srcExe = path.join(base, `src-tauri/target/release/bundle/nsis/Module_${version}_x64-setup.exe`);
const dist = path.join(base, 'dist');
const targetExe = path.join(dist, `Module Setup ${version}.exe`);

fs.copyFileSync(srcExe, targetExe);
console.log('Copied to:', targetExe);

const vDir = path.join(dist, `v${version}`);
if (!fs.existsSync(vDir)) fs.mkdirSync(vDir, { recursive: true });
fs.copyFileSync(srcExe, path.join(vDir, `Module Setup ${version}.exe`));

const zipDir = path.join(vDir, `Module-${version}-win`);
if (!zipDir.startsWith(path.resolve(dist) + path.sep)) throw new Error('Invalid packaging path');
if (fs.existsSync(zipDir)) fs.rmSync(zipDir, { recursive: true, force: true });
fs.mkdirSync(zipDir, { recursive: true });
fs.copyFileSync(path.join(base, 'src-tauri/target/release/module.exe'), path.join(zipDir, 'module.exe'));

const zipFile = path.join(vDir, `Module-${version}-win.zip`);
if (fs.existsSync(zipFile)) fs.rmSync(zipFile, { force: true });

execSync(`tar -a -c -f "${zipFile}" -C "${vDir}" Module-${version}-win`);
console.log('Created zip:', zipFile);
fs.rmSync(zipDir, { recursive: true, force: true });
console.log('Done!');
