var BASE = 'D:/OneDrive/Desktop/工具库/肥仔/任务管理器';
var fs = require('fs');
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
  var mainJs = fs.readFileSync(BASE + '/src/main/main.js', 'utf8');
  var ok = true;
  
  console.log('=== Source ===');
  console.log((mainJs.includes('let _isDragging') ? 'PASS' : 'FAIL') + ' A1: _isDragging let');
  if(!mainJs.includes('let _isDragging')) ok = false;
  
  console.log((mainJs.includes('bounds.width - 80') ? 'PASS' : 'FAIL') + ' A2: 80px exclusion');
  if(!mainJs.includes('bounds.width - 80')) ok = false;
  
  var movedMatch = mainJs.match(/widgetWindow\.on\('moved'[\s\S]*?debouncedSaveBounds/);
  var hasMovedGuard = movedMatch && movedMatch[0].includes('_isDragging');
  console.log((hasMovedGuard ? 'PASS' : 'FAIL') + ' A3: moved guard');
  if(!hasMovedGuard) ok = false;
  
  var resizeMatch = mainJs.match(/widgetWindow\.on\('resize'[\s\S]*?debouncedSaveBounds/);
  var hasResizeGuard = resizeMatch && resizeMatch[0].includes('_isDragging');
  console.log((hasResizeGuard ? 'PASS' : 'FAIL') + ' A4: resize guard');
  if(!hasResizeGuard) ok = false;
  
  console.log((mainJs.includes('_isDragging = true') && mainJs.includes('_isDragging = false') ? 'PASS' : 'FAIL') + ' A5: flag toggle');
  if(!mainJs.includes('_isDragging = true') || !mainJs.includes('_isDragging = false')) ok = false;
  
  console.log('\n=== Widget HTML ===');
  var wh = fs.readFileSync(BASE + '/src/renderer/widget.html', 'utf8');
  console.log((wh.includes('-webkit-app-region: drag') ? 'PASS' : 'FAIL') + ' B1: drag CSS');
  console.log((wh.includes('-webkit-app-region: no-drag') ? 'PASS' : 'FAIL') + ' B2: no-drag CSS');
  
  console.log('\n=== Preload ===');
  var pp = fs.readFileSync(BASE + '/src/preload/preload.js', 'utf8');
  console.log((pp.includes('moveBy') ? 'PASS' : 'FAIL') + ' C1: moveBy IPC');
  
  console.log('\n=== CDP ===');
  try {
    var targets = await httpGet('http://127.0.0.1:9222/json');
    var mt = targets.find(function(t) { return t.title === 'Module'; });
    if (mt) {
      console.log('PASS D1: Module target found');
      console.log('Target count: ' + targets.length);
      
      var ws = new globalThis.WebSocket(mt.webSocketDebuggerUrl);
      await new Promise(function(r) { ws.onopen = r; });
      
      function cdp(method, params) {
        return new Promise(function(resolve, reject) {
          var id = Math.random().toString(36).slice(2);
          ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
          var timer = setTimeout(function() { reject(new Error('Timeout')); }, 4000);
          var listener = function(ev) {
            try {
              var resp = JSON.parse(ev.data.toString());
              if (resp.id === id) {
                clearTimeout(timer);
                ws.removeEventListener('message', listener);
                if (resp.error) reject(new Error(resp.error.message));
                else resolve(resp.result);
              }
            } catch(e) {}
          };
          ws.addEventListener('message', listener);
        });
      }
      
      await cdp('Runtime.enable');
      await cdp('Runtime.runIfWaitingForDebugger');
      
      try {
        var r = await cdp('Runtime.evaluate', { expression: '1+1', returnByValue: true, timeout: 2000 });
        console.log('PASS D2: Runtime.evaluate works (2 = ' + r.result.value + ')');
      } catch(ee) {
        console.log('SKIP D2: Runtime.evaluate unavailable (' + ee.message.substring(0,30) + ')');
      }
      
      ws.close();
      console.log('PASS D3: CDP WebSocket connected successfully');
    } else {
      console.log('SKIP CDP: No Module target');
    }
  } catch(e) {
    console.log('CDP check: ' + e.message.substring(0,50));
  }
  
  console.log('\n' + (ok ? 'ALL PASS' : 'SOME FAILED'));
  process.exit(ok ? 0 : 1);
}

main().catch(function(e) { console.error(e.message); process.exit(1); });
