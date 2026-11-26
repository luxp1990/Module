// 直接通过 Node.js 触发 widget 并测试拖动
// 方法: 连接到 main process 的 debugger, 直接处理
var http = require('http');

function httpGet(url) {
  return new Promise(function(resolve, reject) {
    http.get(url, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Parse: ' + d.substring(0,80))); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
  var targets = await httpGet('http://127.0.0.1:9222/json');
  var mt = targets.find(function(t) { return t.title === 'Module'; });
  if (!mt) { console.log('No Module target'); process.exit(1); return; }
  
  var ws = new globalThis.WebSocket(mt.webSocketDebuggerUrl);
  await new Promise(function(r) { ws.onopen = r; });
  
  function cdp(m, p) {
    return new Promise(function(resolve, reject) {
      var id = Math.random().toString(36).slice(2);
      ws.send(JSON.stringify({ id: id, method: m, params: p || {} }));
      var timer = setTimeout(function() { reject(new Error('Timeout')); }, 5000);
      var listener = function(ev) {
        try {
          var resp = JSON.parse(ev.data.toString());
          if (resp.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', listener);
            if (resp.error) reject(new Error(resp.error.message));
            else resolve(resp.result);
          }
        } catch(e) { /* expected for non-JSON CDP events */ }
      };
      ws.addEventListener('message', listener);
    });
  }
  
  try {
    // Step 1: Enable Runtime
    console.log('Enabling Runtime...');
    await cdp('Runtime.enable');
    console.log('PASS: Runtime enabled');
    
    // Step 2: Check current execution context
    var ctx = await cdp('Runtime.executionContextsCreated');
    
    // Step 3: runIfWaitingForDebugger
    console.log('Unfreezing renderer...');
    await cdp('Runtime.runIfWaitingForDebugger');
    console.log('PASS: Renderer unfrozen');
    
    await sleep(1000);
    
    // Step 4: Wait for console messages to verify page loaded
    console.log('Checking page...');
    
    // Try to get the document
    try {
      var doc = await cdp('DOM.getDocument', { depth: 1 });
      console.log('PASS: DOM available, root=' + doc.root.nodeName);
    } catch(e) {
      console.log('DOM.getDocument failed: ' + e.message.substring(0,40));
      
      // Fall back to plain evaluate
      try {
        var r = await cdp('Runtime.evaluate', {
          expression: 'typeof window !== "undefined" ? "ok" : "no_window"',
          returnByValue: true,
          timeout: 2000
        });
        console.log('Runtime available: ' + JSON.stringify(r.result.value));
      } catch(e2) {
        console.log('Runtime.evaluate still fails: ' + e2.message.substring(0,40));
      }
    }
    
    // Step 5: If DOM is available, check widget-header
    // ... 
    
  } catch(e) {
    console.log('Error: ' + e.message.substring(0, 80));
  }
  
  ws.close();
  process.exit(0);
}

main().catch(function(e) { console.error(e.message); process.exit(1); });
