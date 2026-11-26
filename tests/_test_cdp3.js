// CDP 调试: 绕过 Runtime.evaluate 超时问题  
var http = require('http');

function httpGet(url) {
  return new Promise(function(resolve, reject) {
    http.get(url, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Parse error')); }
      });
    }).on('error', reject);
  });
}

async function main() {
  var targets = await httpGet('http://127.0.0.1:9222/json');
  var mt = targets.find(function(t) { return t.title === 'Module'; });
  if (!mt) { console.log('FAIL: No Module target'); process.exit(1); return; }
  
  console.log('Target:', mt.title);
  console.log('WS URL:', mt.webSocketDebuggerUrl);
  
  var ws = new globalThis.WebSocket(mt.webSocketDebuggerUrl);
  await new Promise(function(r) { ws.onopen = r; });
  console.log('WebSocket connected');
  
  var msgId = 0;
  var pending = {};
  
  ws.onmessage = function(ev) {
    try {
      var resp = JSON.parse(ev.data.toString());
      if (resp.id && pending[resp.id]) {
        pending[resp.id](resp);
        delete pending[resp.id];
      }
      // Print some events for debugging
      if (resp.method && resp.method.startsWith('Runtime.')) {
        console.log('CDP event:', resp.method, JSON.stringify(resp.params).substring(0, 80));
      }
    } catch(e) {}
  };
  
  function send(method, params) {
    return new Promise(function(resolve, reject) {
      var id = ++msgId;
      pending[id] = function(resp) {
        if (resp.error) reject(new Error(resp.error.message));
        else resolve(resp.result);
      };
      var timer = setTimeout(function() {
        delete pending[id];
        reject(new Error('Timeout: ' + method));
      }, 8000);
      pending[id]._timer = timer;
      pending[id]._resolveOnTimer = function() {
        clearTimeout(timer);
        resolve(null); // resolve with null on timeout
      };
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  
  // First, just enable console to see what's happening
  var r1 = await send('Runtime.enable');
  console.log('Runtime.enable:', r1 ? 'ok' : 'no result');
  
  // Don't call runIfWaitingForDebugger yet - maybe the renderer isn't paused
  // Try evaluate without it
  var r2 = await send('Runtime.evaluate', {
    expression: 'navigator.userAgent',
    returnByValue: true,
    generatePreview: false
  });
  if (r2 && r2.result) {
    console.log('Runtime.evaluate OK:', r2.result.value);
  } else {
    console.log('Runtime.evaluate no result (possibly waiting for debugger)');
    
    // Try calling runIfWaitingForDebugger
    await send('Runtime.runIfWaitingForDebugger');
    console.log('Called runIfWaitingForDebugger, waiting...');
    
    await new Promise(function(r) { setTimeout(r, 2000); });
    
    var r3 = await send('Runtime.evaluate', {
      expression: 'navigator.userAgent',
      returnByValue: true,
      generatePreview: false
    });
    if (r3 && r3.result) {
      console.log('Runtime.evaluate OK after unfreeze:', r3.result.value.substring(0, 60));
      
      // Now check widget API
      var apichk = await send('Runtime.evaluate', {
        expression: 'window._api && window._api.widget ? "has_widget_api" : "no_widget_api"',
        returnByValue: true
      });
      console.log('Widget API:', apichk ? apichk.result.value : 'timeout');
      
      if (apichk && apichk.result.value === 'has_widget_api') {
        // Toggle widget
        var w = await send('Runtime.evaluate', {
          expression: '(async function(){ var w = window._api.widget; var s = await w.status(); if(!s.open) await w.toggle(); return (await w.status()).open ? "open" : "fail"; })()',
          returnByValue: true,
          awaitPromise: true
        });
        console.log('Widget toggle:', w ? w.result.value : 'timeout');
        
        await new Promise(function(r) { setTimeout(r, 2000); });
        
        // Check targets again
        var t2 = await httpGet('http://127.0.0.1:9222/json');
        console.log('Windows after toggle:', t2.length);
        t2.forEach(function(t) { console.log('  ' + t.title); });
        
        // Test widget CSS
        if (t2.length > 1) {
          var widgetTarget = t2.find(function(t) { return t.title.includes('widget') || t.title === 'Module Widget'; });
          if (widgetTarget) {
            console.log('\nWidget target found:', widgetTarget.title);
          } else {
            // Try finding by url
            var widgetTgt = t2.find(function(t) { return t.webSocketDebuggerUrl !== mt.webSocketDebuggerUrl; });
            if (widgetTgt) {
              console.log('\nOther target:', widgetTgt.title, widgetTgt.url ? widgetTgt.url.substring(0,60) : '');
            } else {
              console.log('\nWidget may be single-process (no separate target)');
            }
          }
        }
      }
    } else {
      console.log('Runtime.evaluate still fails after unfreeze');
    }
  }
  
  ws.close();
  console.log('\nDone');
  process.exit(0);
}

main().catch(function(e) { console.error(e.message); process.exit(1); });
