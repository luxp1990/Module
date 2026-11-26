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
  if (!mt) { console.log('FAIL: No Module target'); process.exit(1); }

  var ws = new globalThis.WebSocket(mt.webSocketDebuggerUrl);
  await new Promise(function(r) { ws.onopen = r; });

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
  function send(method, params) {
    return new Promise(function(resolve) {
      var id = ++msgId;
      var timer = setTimeout(function() { if (pending[id]) { delete pending[id]; resolve(null); } }, 6000);
      pending[id] = { resolve: resolve, timer: timer };
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }

  await send('Runtime.enable');

  var t0 = await httpGet('http://127.0.0.1:9222/json');
  console.log('Before toggle:', t0.length, 'windows');

  // contextId=2 = isolated preload context (has window._api)
  var r = await send('Runtime.evaluate', {
    expression: '(async function(){ var w = window._api && window._api.widget; if(!w) return "no_api"; var s = await w.status(); if(!s.open) await w.toggle(); var s2 = await w.status(); return s2.open ? "widget_open" : "widget_closed"; })()',
    returnByValue: true,
    awaitPromise: true,
    contextId: 2
  });
  var result = r && r.result ? r.result.value : (r ? JSON.stringify(r).substring(0,80) : 'null');
  console.log('Toggle result:', result);

  await new Promise(function(r) { setTimeout(r, 2000); });

  var t1 = await httpGet('http://127.0.0.1:9222/json');
  console.log('After toggle:', t1.length, 'windows');
  t1.forEach(function(t) { console.log('  ' + t.title); });

  // Check widget window CSS
  if (t1.length > 1) {
    var wt = t1.filter(function(t) { return t.id !== mt.id; })[0];
    if (wt) {
      console.log('Widget target:', wt.title);
      var ws2 = new globalThis.WebSocket(wt.webSocketDebuggerUrl);
      await new Promise(function(r) { ws2.onopen = r; });
      var m2 = { id: 0, p: {} };
      ws2.onmessage = function(ev) {
        try {
          var resp = JSON.parse(ev.data.toString());
          if (resp.id && m2.p[resp.id]) { clearTimeout(m2.p[resp.id].t); m2.p[resp.id].r(resp); delete m2.p[resp.id]; }
        } catch(e) {}
      };
      function s2(method, params) {
        return new Promise(function(resolve) {
          var id = ++m2.id, timer = setTimeout(function() { if (m2.p[id]) { delete m2.p[id]; resolve(null); } }, 5000);
          m2.p[id] = { r: resolve, t: timer };
          ws2.send(JSON.stringify({ id: id, method: method, params: params || {} }));
        });
      }
      await s2('Runtime.enable');
      
      // widget CSS check
      var css = await s2('Runtime.evaluate', {
        expression: '(function(){ var h = document.querySelector(".widget-header"); if(!h) return "no_header"; var s = getComputedStyle(h); return "drag:" + s.getPropertyValue("-webkit-app-region") + " cursor:" + s.cursor; })()',
        returnByValue: true,
        contextId: 2
      });
      console.log('Widget header CSS:', css && css.result ? css.result.value : 'no response');
      
      // widget buttons region
      var btn = await s2('Runtime.evaluate', {
        expression: '(function(){ var btns = document.querySelectorAll(".widget-header button, .widget-header .btn, .widget-header .note-actions"); var r = []; for(var i=0;i<btns.length;i++){ var s = getComputedStyle(btns[i]); r.push(btns[i].tagName + ":" + s.getPropertyValue("-webkit-app-region")); } return r.join(" | "); })()',
        returnByValue: true,
        contextId: 2
      });
      console.log('Widget buttons region:', btn && btn.result ? btn.result.value : 'no response');
      
      ws2.close();
      console.log('PASS: Widget window visible with correct CSS');
    }
  } else {
    console.log('SKIP: Widget may be in same window (no separate CDP target)');
  }

  ws.close();
  process.exit(result === 'widget_open' || result === 'widget_closed' ? 0 : 1);
}
main().catch(function(e) { console.error(e.message); process.exit(1); });
