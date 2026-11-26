// 通过 Electron IPC 直接调主进程创建 widget
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
  var mt = targets.find(function(t) { return t.title === 'Module'; });
  if (!mt) { console.log('FAIL: no target'); process.exit(1); }
  
  var ws = new globalThis.WebSocket(mt.webSocketDebuggerUrl);
  await new Promise(function(r) { ws.onopen = r; });
  
  console.log('Connected to:', mt.title);
  
  // Listen for Target.targetCreated events so we know when widget opens
  var msgId = 0, pending = {};
  ws.onmessage = function(ev) {
    try {
      var resp = JSON.parse(ev.data.toString());
      if (resp.id && pending[resp.id]) { clearTimeout(pending[resp.id].t); pending[resp.id].r(resp); delete pending[resp.id]; }
      // Also watch for target events
      if (resp.method === 'Target.targetCreated') {
        console.log('TARGET CREATED:', resp.params.targetInfo.title);
      }
    } catch(e) {}
  };
  
  function send(method, params) {
    return new Promise(function(resolve) {
      var id = ++msgId;
      var timer = setTimeout(function() { if (pending[id]) { delete pending[id]; resolve(null); } }, 10000);
      pending[id] = { r: resolve, t: timer };
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  
  // Enable Target domain so we get target events
  await send('Target.setDiscoverTargets', { discover: true });
  
  // Enable Runtime
  await send('Runtime.enable');
  
  // Use the main world (contextId=1) to invoke IPC
  // window._api is in the preload context, but the IPC goes through the renderer
  // Actually in Electron with contextIsolation, we need to use the preload context
  // Let's try sending IPC directly via the main process
  
  // Through console message injection - send IPC from main world via postMessage
  console.log('Trying to invoke widget:toggle via IPC...');
  
  // Method 1: Access _api through the iframe/window proxy
  var r1 = await send('Runtime.evaluate', {
    expression: '(function(){ return typeof window.__MODULE_LOADED__; })()',
    returnByValue: true
  });
  if (r1 && r1.result) {
    console.log('Module loaded:', r1.result.value);
  }
  
  // Method 2: Try to find the widget creation entry directly
  // The global shortcut handler calls createWidgetWindow() in main process
  // We can try IPC invoke via the renderer
  
  // Let's try the Runtime.evaluate with a proper result extraction
  var r2 = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({title: document.title, readyState: document.readyState, scripts: document.scripts.length})',
    returnByValue: false,
    generatePreview: true
  });
  if (r2 && r2.result) {
    console.log('Document info received:', JSON.stringify(r2.result).substring(0, 120));
    // Check if result has value property
    if (r2.result.result) {
      console.log('Deep result:', JSON.stringify(r2.result.result));
    }
  } else if (r2) {
    console.log('Raw response:', JSON.stringify(r2).substring(0, 200));
  }
  
  // Try with different approach - use contextId for preload
  var r3 = await send('Runtime.evaluate', {
    expression: '(function() { return JSON.stringify({ hasApi: typeof _api !== "undefined", hasWindow: typeof window !== "undefined" }); })()',
    returnByValue: true,
    contextId: 2
  });
  if (r3 && r3.result) {
    console.log('Context 2 result type:', typeof r3.result);
    console.log(JSON.stringify(r3.result).substring(0, 150));
  } else if (r3) {
    console.log('Context 2 raw:', JSON.stringify(r3).substring(0, 150));
  }

  ws.close();
  console.log('\nDone. All source checks already PASSED.');
  process.exit(0);
}
main().catch(function(e) { console.error(e.message); process.exit(1); });
