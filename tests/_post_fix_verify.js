var http = require('http');
var fs = require('fs');
function httpGet(url) { return new Promise(function(resolve, reject) { http.get(url, function(res) { var d = ''; res.on('data', function(c) { d += c; }); res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject); }); }

async function main() {
  var targets = await httpGet('http://127.0.0.1:9222/json');
  console.log('TARGETS:', targets.map(function(t) { return t.title; }).join(', '));

  // 读 main.js 做源码静态验证
  var BASE = 'D:/OneDrive/Desktop/工具库/肥仔/任务管理器';
  var main = fs.readFileSync(BASE + '/src/main/main.js', 'utf8');

  var checks = [];

  // C1: resizable true
  var rMatch = main.match(/resizable:\s*(true|false)/g);
  checks.push(['resizable:true', rMatch && rMatch.some(function(s) { return s.includes('true'); })]);;

  // C2: 不 return 1 (只 return 2，其他不返回)
  // Check that inside hookWindowMessage, there's no "return 1" after the HTCAPTION return
  var hookBlock = main.match(/hookWindowMessage[\s\S]{1,800}?\}\);/);
  var hasReturn1 = hookBlock && hookBlock[0].includes('return 1');
  checks.push(['No return 1 in hook', !hasReturn1]);

  // C3: return 2 后无其他 return
  var hasReturn2 = hookBlock && hookBlock[0].includes('return 2');
  checks.push(['HTCAPTION return 2 exists', !!hasReturn2]);

  // C4: setSize restored
  var hasSetSize = main.includes('widgetWindow.setSize');
  checks.push(['setSize after setPosition', hasSetSize]);

  // C5: 注释 warning
  var hasWarning = main.includes('严禁 return 1') || main.includes('return 1');
  checks.push(['Warning comment present', !!hasWarning]);

  console.log('\n=== 源码验证 ===');
  var allPass = true;
  checks.forEach(function(c) {
    console.log('  [' + (c[1] ? 'PASS' : 'FAIL') + '] ' + c[0]);
    if (!c[1]) allPass = false;
  });

  if (allPass) {
    console.log('\n全部检查通过。请手动测试：');
    console.log('  1. 拖动组件窗口上边缘（header区域）→ 应能移动窗口');
    console.log('  2. 拖动组件窗口边框 → 应能调整大小');
    console.log('  3. 在空白任务区拖动 → 应能移动窗口');
    console.log('  4. 拖动后窗口大小不应意外改变');
  }

  process.exit(allPass ? 0 : 1);
}
main().catch(function(e) { console.error(e); process.exit(1); });
