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
async function main() {
  var targets = await httpGet('http://127.0.0.1:9222/json');
  
  // 找到 widget 窗口 (title 包含 组件)
  var wt = targets.find(function(t) { return t.title.includes('组件'); });
  if (!wt) { console.log('FAIL: no widget target'); process.exit(1); return; }
  console.log('=== 桌面组件运行时测试 ===\n');
  console.log('Widget title:', wt.title);
  
  var ws = new globalThis.WebSocket(wt.webSocketDebuggerUrl);
  await new Promise(function(r) { ws.onopen = r; });
  console.log('Connected to widget window\n');
  
  var msgId = 0, pending = {};
  ws.onmessage = function(ev) {
    try {
      var resp = JSON.parse(ev.data.toString());
      if (resp.id && pending[resp.id]) {
        clearTimeout(pending[resp.id].timer);
        pending[resp.id].resolve(resp);
        delete pending[resp.id];
      }
    } catch(e) {}
  };
  function send(method, params, timeout) {
    return new Promise(function(resolve) {
      var id = ++msgId;
      var timer = setTimeout(function() { if (pending[id]) { delete pending[id]; resolve(null); } }, timeout || 5000);
      pending[id] = { resolve: resolve, timer: timer };
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  
  await send('Runtime.enable');
  
  // Test 1: widget-header drag region
  console.log('Test 1: widget-header -webkit-app-region');
  var r1 = await send('Runtime.evaluate', {
    expression: '(function(){ var h = document.querySelector(".widget-header"); if(!h) return JSON.stringify({err:"no_header"}); var s = getComputedStyle(h); return JSON.stringify({region: s.getPropertyValue("-webkit-app-region"), cursor: s.cursor, pe: s.pointerEvents}); })()',
    returnByValue: true
  });
  var v1 = r1 && r1.result ? JSON.parse(r1.result.value) : null;
  if (v1 && v1.region === 'drag') {
    console.log('  PASS: widget-header region = "' + v1.region + '"');
  } else {
    console.log('  FAIL: widget-header region = ' + JSON.stringify(v1));
  }
  
  // Test 2: buttons have no-drag
  console.log('\nTest 2: Buttons -webkit-app-region');
  var r2 = await send('Runtime.evaluate', {
    expression: '(function(){ var btns = document.querySelectorAll(".widget-header button, .widget-header .note-actions, .widget-header .tabs, .widget-header .tab"); var r = []; for(var i=0;i<btns.length;i++){ var s = getComputedStyle(btns[i]); r.push(btns[i].tagName + (btns[i].className ? "." + btns[i].className.substring(0,15) : "") + " => " + s.getPropertyValue("-webkit-app-region")); } return JSON.stringify(r); })()',
    returnByValue: true
  });
  var v2 = r2 && r2.result ? JSON.parse(r2.result.value) : null;
  if (v2) {
    var allNoDrag = v2.every(function(x) { return x.includes('no-drag'); });
    console.log(v2.map(function(x) { return '  ' + x; }).join('\n'));
    console.log(allNoDrag ? '  PASS: All buttons have no-drag' : '  FAIL: Some buttons missing no-drag');
  } else {
    console.log('  FAIL: no button data');
  }
  
  // Test 3: HookWindowMessage 排除区 (验证 source - 行上)
  console.log('\nTest 3: HookWindowMessage 排除区 80px');
  var fs = require('fs');
  var main = fs.readFileSync('src/main/main.js', 'utf8');
  var exclMatch = main.match(/localX\s*<=\s*bounds\.width\s*-\s*(\d+)/);
  if (exclMatch && exclMatch[1] === '80') {
    console.log('  PASS: Exclusion zone = ' + exclMatch[1] + 'px');
  } else {
    console.log('  FAIL: Exclusion zone = ' + (exclMatch ? exclMatch[1] : 'UNKNOWN'));
  }
  
  // Test 4: IsDragging guard on moved/resize
  console.log('\nTest 4: _isDragging guards on moved/resize');
  var movedG = main.match(/on\('moved'[\s\S]{0,200}?_isDragging[\s\S]{0,200}?debouncedSaveBounds/);
  var resizeG = main.match(/on\('resize'[\s\S]{0,200}?_isDragging[\s\S]{0,200}?debouncedSaveBounds/);
  console.log('  moved guard: ' + (movedG ? 'PASS' : 'FAIL'));
  console.log('  resize guard: ' + (resizeG ? 'PASS' : 'FAIL'));
  
  // Test 5: 验证 body 上是否有 mousedown 手动拖动监听
  console.log('\nTest 5: Body drag handler and flag toggle');
  var r5 = await send('Runtime.evaluate', {
    expression: '(function(){ var btn = document.querySelector("#pinBtn"); return JSON.stringify({pinBtn: !!btn, hasStyle: document.querySelector("body").hasAttribute("style")}); })()',
    returnByValue: true
  });
  console.log('  Body/buttons: ' + (r5 && r5.result ? r5.result.value : 'no data'));
  
  // Test 6: 验证 widget:moveBy IPC 通道
  console.log('\nTest 6: widget:moveBy IPC channel');
  var hasMoveBy = main.includes("'widget:moveBy'");
  console.log('  moveBy IPC: ' + (hasMoveBy ? 'PASS' : 'FAIL'));
  
  var hasFlagSet = main.includes('_isDragging = true') && main.includes('_isDragging = false');
  console.log('  flag toggle: ' + (hasFlagSet ? 'PASS' : 'FAIL'));
  
  ws.close();
  
  // Summary
  var allPass = true;
  var checks = [
    ['widget-header drag CSS', v1 && v1.region === 'drag'],
    ['Buttons no-drag CSS', v2 && v2.every(function(x) { return x.includes('no-drag'); })],
    ['Exclusion zone 80px', exclMatch && exclMatch[1] === '80'],
    ['moved guard', !!movedG],
    ['resize guard', !!resizeG],
    ['moveBy IPC channel', hasMoveBy],
    ['_isDragging flag toggle', hasFlagSet]
  ];
  
  console.log('\n' + '='.repeat(50));
  console.log('  测试结果汇总');
  console.log('='.repeat(50));
  checks.forEach(function(c) {
    console.log('  [' + (c[1] ? 'PASS' : 'FAIL') + '] ' + c[0]);
    if (!c[1]) allPass = false;
  });
  console.log('='.repeat(50));
  console.log(allPass ? '\n✅ 全部通过，可以打包！' : '\n❌ 有失败项');
  
  process.exit(allPass ? 0 : 1);
}
main().catch(function(e) { console.error('FATAL:', e.message); process.exit(1); });
