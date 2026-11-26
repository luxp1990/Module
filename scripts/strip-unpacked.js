// 砍掉 win-unpacked 里的非必需文件
// 这些都是 Electron 32+ 自带的 Chromium 二进制,本地任务管理器用不到
// 单文件 exe 大小、内存占用都会显著下降
//
// 两种调用方式:
//   1) electron-builder afterPack hook: 传 context,我们读 context.packager.appOutDir
//   2) 手动:node scripts/strip-unpacked.js  → 默认找 dist/win-unpacked
const fs = require('fs');
const path = require('path');

let distRoot;
// afterPack hook 签名: async (context) => Promise<...>
if (process.argv.length >= 5 && process.argv[2] === '--hook') {
  // electron-builder 调用方式: node strip-unpacked.js --hook <context-json>
  // 但 electron-builder 实际是直接 require 我们,所以通常走 module.exports
  distRoot = process.argv[3];
} else {
  distRoot = path.join(__dirname, '..', 'dist', 'win-unpacked');
}

if (!distRoot || !fs.existsSync(distRoot)) {
  console.error('[strip] dist root not found:', distRoot);
  if (require.main === module) process.exit(0);
}

// 不需要的 dll (关硬件加速 + 关音视频后可全删)
// ⚠️ 注意:即便关掉 GPU,exe 在 LoadLibrary 时仍会引用这些 dll (静态依赖)
// 真正安全的方法:用 electron-builder 的 `electronLanguages` 配 locale,但不要删 dll
// 这里先全部保留 dll,只清理 locale + pak + html
const removeDlls = new Set([
  // 暂时全保留 — Electron 的 exe 即使在 GPU 关掉时也会 LoadLibrary 这些 dll
  // 如果硬删,会触发 STATUS_DLL_NOT_FOUND (0xC0000135)
]);

// 不要的 pak / dat / bin / html
const removeFiles = new Set([
  'LICENSES.chromium.html',
  'chrome_200_percent.pak',
]);

// 只保留 zh-CN 和 en-US 两个 locale pak
const keepLocales = new Set(['zh-CN.pak', 'en-US.pak']);

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function strip(root) {
  let removedBytes = 0;
  let removedCount = 0;

  for (const f of [...removeDlls, ...removeFiles]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) {
      const sz = sizeOf(p);
      fs.unlinkSync(p);
      removedBytes += sz;
      removedCount++;
      console.log(`[strip] rm ${f} (${(sz/1024).toFixed(0)}KB)`);
    }
  }

  const localesDir = path.join(root, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const f of fs.readdirSync(localesDir)) {
      if (keepLocales.has(f)) continue;
      const p = path.join(localesDir, f);
      const sz = sizeOf(p);
      fs.unlinkSync(p);
      removedBytes += sz;
      removedCount++;
    }
    console.log(`[strip] kept locales: ${[...keepLocales].join(', ')}`);
  }

  const elevate = path.join(root, 'resources', 'elevate.exe');
  if (fs.existsSync(elevate)) {
    const sz = sizeOf(elevate);
    fs.unlinkSync(elevate);
    removedBytes += sz;
    removedCount++;
    console.log(`[strip] rm resources/elevate.exe (${(sz/1024).toFixed(0)}KB)`);
  }

  console.log(`[strip] done. removed ${removedCount} files, ${(removedBytes/1024/1024).toFixed(2)}MB`);
}

// electron-builder afterPack 钩子调用方式:导出异步函数,签名 (context)
module.exports = async function afterPack(context) {
  // AfterPackContext = PackContext,直接 context.appOutDir 读
  const appOutDir = context && context.appOutDir;
  if (!appOutDir) {
    console.error('[strip] no appOutDir in context, skip');
    return;
  }
  console.log('[strip] afterPack on:', appOutDir);
  strip(appOutDir);
};

// 手动调用入口
if (require.main === module) {
  strip(distRoot);
}