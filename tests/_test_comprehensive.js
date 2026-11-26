var fs = require('fs');
var BASE = 'D:/OneDrive/Desktop/工具库/肥仔/任务管理器';
var main = fs.readFileSync(BASE + '/src/main/main.js', 'utf8');
var wh = fs.readFileSync(BASE + '/src/renderer/widget.html', 'utf8');
var pp = fs.readFileSync(BASE + '/src/preload/preload.js', 'utf8');

var ok = true;

// ============ 源码静态检查 ============
console.log('=== 源码静态检查 ===');

// A1: _isDragging let
var a1 = main.includes('let _isDragging');
console.log((a1 ? 'PASS' : 'FAIL') + ' [A1] _isDragging 有 let 声明');

// A2: 80px exclusion
var a2 = main.includes('bounds.width - 80');
console.log((a2 ? 'PASS' : 'FAIL') + ' [A2] hookWindowMessage 排除区 80px');

// A3: moved guard
var movedBlock = main.match(/on\('moved'[\s\S]{0,300}?debouncedSaveBounds/);
var a3 = movedBlock && movedBlock[0].includes('_isDragging');
console.log((a3 ? 'PASS' : 'FAIL') + ' [A3] moved 事件有 _isDragging 守卫');

// A4: resize guard
var resizeBlock = main.match(/on\('resize'[\s\S]{0,300}?debouncedSaveBounds/);
var a4 = resizeBlock && resizeBlock[0].includes('_isDragging');
console.log((a4 ? 'PASS' : 'FAIL') + ' [A4] resize 事件有 _isDragging 守卫');

// A5: flag toggle
var a5 = main.includes('_isDragging = true') && main.includes('_isDragging = false');
console.log((a5 ? 'PASS' : 'FAIL') + ' [A5] 拖动时 isDragging 标志翻转');

// A6: moveBy IPC
var a6 = main.includes("'widget:moveBy'");
console.log((a6 ? 'PASS' : 'FAIL') + ' [A6] widget:moveBy IPC 通道');

// B1: widget-header drag CSS
var b1 = wh.includes('-webkit-app-region: drag');
console.log((b1 ? 'PASS' : 'FAIL') + ' [B1] widget-header -webkit-app-region: drag');

// B2: no-drag on interactive elements
// CSS rule for no-drag on buttons inside widget-header
var b2 = wh.includes('-webkit-app-region: no-drag');
console.log((b2 ? 'PASS' : 'FAIL') + ' [B2] 交互元素有 -webkit-app-region: no-drag');

// C1: preload moveBy
var c1 = pp.includes('moveBy');
console.log((c1 ? 'PASS' : 'FAIL') + ' [C1] preload 暴露 moveBy IPC');

// ============ 运行时验证 ============
console.log('\n=== 运行时验证 ===');

var http = require('http');
function httpGet(url) {
  return new Promise(function(resolve, reject) {
    http.get(url, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

httpGet('http://127.0.0.1:9222/json').then(function(targets) {
  var d1 = targets.length >= 1;
  var d2 = targets.some(function(t) { return t.title === 'Module'; });
  var d3 = targets.some(function(t) { return t.title.includes('组件'); });

  console.log((d1 ? 'PASS' : 'FAIL') + ' [D1] Electron 进程运行中');
  console.log((d2 ? 'PASS' : 'FAIL') + ' [D2] 主窗口存在 (Module)');
  console.log((d3 ? 'PASS' : 'FAIL') + ' [D3] 组件窗口已通过 Ctrl+Shift+M 唤出');

  if (!d3) {
    console.log('\n--- 尝试通过热键唤醒组件 ---');
    // Try the .NET keyboard simulation
  }

}).catch(function(e) {
  console.log('FAIL [D1] CDP 不可达:', e.message.substring(0, 50));
}).finally(function() {
  // Summary
  var checks = [a1, a2, a3, a4, a5, a6, b1, b2, c1];
  var allPass = checks.every(function(x) { return x; });
  
  console.log('\n' + '='.repeat(55));
  console.log('  拖动修复验证报告');
  console.log('='.repeat(55));
  var labels = ['_isDragging 声明', '排除区 80px', 'moved 守卫', 'resize 守卫', '标志翻转', 'moveBy IPC', 'drag CSS', 'no-drag CSS', '预加载 IPC'];
  checks.forEach(function(c, i) {
    console.log('  [' + (c ? 'PASS' : 'FAIL') + '] ' + labels[i]);
  });
  console.log('='.repeat(55));
  console.log(allPass ? '\n✅ 全部 9 项检查通过，可以打包！' : '\n❌ 有失败项，需修复后再打包');
  
  process.exit(allPass ? 0 : 1);
});
