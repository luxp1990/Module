var http = require('http');

function httpGet(url) {
  return new Promise(function(resolve, reject) {
    http.get(url, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  var targets = await httpGet('http://127.0.0.1:9222/json');
  var mt = targets.find(function(t) { return t.title === 'Module'; });
  if (!mt) { console.log('FAIL: No Module target'); process.exit(1); return; }
  
  var ws = new globalThis.WebSocket(mt.webSocketDebuggerUrl);
  await new Promise(function(r) { ws.onopen = r; });
  
  var msgId = 0;
  var pending = {};
  
  ws.onmessage = function(ev) {
    try {
      var resp = JSON.parse(ev.data.toString());
      if (resp.id && pending[resp.id]) {
        clearTimeout(pending[resp.id].timer);
        pending[resp.id].resolve(resp.result || resp);
        delete pending[resp.id];
      }
    } catch(e) {}
  };
  
  function send(method, params) {
    return new Promise(function(resolve, reject) {
      var id = ++msgId;
      var timer = setTimeout(function() {
        if (pending[id]) { delete pending[id]; resolve(null); }
      }, 8000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  
  var t0 = await httpGet('http://127.0.0.1:9222/json');
  console.log('Before toggle - targets:', t0.length);
  
  await send('Runtime.enable');
  
  // Toggle widget
  var r = await send('Runtime.evaluate', {
    expression: '(async function(){ var w = window._api && window._api.widget; if(!w) return "no_api"; var s = await w.status(); if(!s.open) await w.toggle(); var s2 = await w.status(); return s2.open ? "widget_open" : "widget_closed"; })()',
    returnByValue: true,
    awaitPromise: true
  });
  console.log('Toggle result:', r && r.result ? r.result.value : 'no response');
  
  await new Promise(function(r) { setTimeout(r, 2000); });
  
  var t1 = await httpGet('http://127.0.0.1:9222/json');
  console.log('After toggle - targets:', t1.length);
  t1.forEach(function(t) { console.log('  ' + t.title + ' - ' + (t.url ? t.url.substring(0,60) : '')); });
  
  // If widget is open, check its CSS
  if (t1.length > 1) {
    var wt = t1.find(function(t) { return t.title === 'Module Widget' || t.url.includes('widget.html'); });
    if (!wt) {
      // Take the first non-main target
      wt = t1.filter(function(t) { return t.id !== mt.id; })[0];
    }
    if (wt) {
      console.log('Widget target:', wt.title);
      
      var ws2 = new globalThis.WebSocket(wt.webSocketDebuggerUrl);
      await new Promise(function(r) { ws2.onopen = r; });
      
      var m2 = { id: 0, p: {} };
      ws2.onmessage = function(ev) {
        try {
          var resp = JSON.parse(ev.data.toString());
          if (resp.id && m2.p[resp.id]) {
            clearTimeout(m2.p[resp.id].t);
            m2.p[resp.id].r(resp.result || resp);
            delete m2.p[resp.id];
          }
        } catch(e) {}
      };
      
      function send2(method, params) {
        return new Promise(function(resolve, reject) {
          var id = ++m2.id;
          var timer = setTimeout(function() { if (m2.p[id]) { delete m2.p[id]; resolve(null); } }, 5000);
          m2.p[id] = { r: resolve, t: timer };
          ws2.send(JSON.stringify({ id: id, method: method, params: params || {} }));
        });
      }
      
      await send2('Runtime.enable');
      
      // Check widget-header CSS
      var cssR = await send2('Runtime.evaluate', {
        expression: '(function(){ var h = document.querySelector(".widget-header"); if(!h) return JSON.stringify({err:"no_header"}); var s = getComputedStyle(h); return JSON.stringify({region:s.getPropertyValue("-webkit-app-region"), cursor:s.cursor, pe:s.pointerEvents}); })()',
        returnByValue: true
      });
      console.log('Widget CSS:', cssR && cssR.result ? cssR.result.value : 'no response');
      
      // Check buttons have no-drag
      var btnR = await send2('Runtime.evaluate', {
        expression: '(function(){ var btns = document.querySelectorAll(".widget-header button, .widget-header .btn"); var results = []; for(var i=0;i<btns.length;i++){ var s = getComputedStyle(btns[i]); results.push({region:s.getPropertyValue("-webkit-app-region"), tag:btns[i].tagName, cls:btns[i].className.substring(0,20)}); } return JSON.stringify(results); })()',
        returnByValue: true
      });
      console.log('Widget buttons:', btnR && btnR.result ? btnR.result.value : 'no response');
      
      // Check body drag handler
      var bodyR = await send2('Runtime.evaluate', {
        expression: '(function(){ var els = document.querySelectorAll("[style*=\'webkit-app-region\']"); var results = []; for(var i=0;i<els.length;i++){ results.push(els[i].tagName + "." + (els[i].className||"").substring(0,15) + " => " + (els[i].style.webkitAppRegion || els[i].getAttribute("style"))); } return results.length ? JSON.stringify(results) : "no inline region styles"; })()',
        returnByValue: true
      });
      console.log('Inline region:', bodyR && bodyR.result ? bodyR.result.value : 'no response');
      
      ws2.close();
    }
  } else {
    console.log('Widget may be already open (no new target) or single-process window');
    
    // Check from main window
    var cssR = await send('Runtime.evaluate', {
      expression: '(async function(){ try { var w = window._api && window._api.widget; if(!w) return "no_widget_api"; var s = await w.status(); return s.open ? "widget_is_open" : "widget_is_closed"; } catch(e) { return "err:"+e.message; } })()',
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Widget status from main:', cssR && cssR.result ? cssR.result.value : 'no response');
  }
  
  ws.close();
  console.log('\nDONE');
  process.exit(0);
}

main().catch(function(e) { console.error('FATAL:', e.message); process.exit(1); });
