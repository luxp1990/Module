// 给 Module.exe 写入版本资源 (FileVersion / ProductVersion)
// 复用方式:
//   1) 默认: node scripts/rcedit-version.mjs
//      自动读取 package.json 的 version, 修改 dist/win-unpacked/Module.exe
//   2) 指定 exe: node scripts/rcedit-version.mjs <exe路径>
//   3) 指定 exe + 版本: node scripts/rcedit-version.mjs <exe路径> <版本号>
//
// ⚠️ 打包流程注意:
//   rcedit 改过 exe 后, electron-builder 会误判 zip "up to date" 跳过,
//   必须删除旧 zip / nsis 包后再 --prepackaged 重打。
import { rcedit } from 'rcedit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 解析参数
let target = process.argv[2];
let version = process.argv[3];

if (!target) {
  target = path.join(root, 'dist', 'win-unpacked', 'Module.exe');
}

if (!version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  version = pkg.version;
}

if (!version) {
  console.error('[rcedit] 未找到版本号, 请传入或检查 package.json');
  process.exit(1);
}

if (!fs.existsSync(target)) {
  console.error('[rcedit] exe 不存在:', target);
  process.exit(1);
}

const options = {
  'version-string': {
    FileVersion: version,
    ProductVersion: version,
    ProductName: 'Module',
  },
  'file-version': version,
  'product-version': version,
};

await rcedit(target, options);
console.log(`[rcedit] OK -> ${target}  (version ${version})`);
