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
  var t = await httpGet('http://127.0.0.1:9222/json');
  var wt = t.find(function(x) { return x.title.includes('组件'); });
  if (!wt) { console.log('FAIL: no widget'); process.exit(1); }

  var ws = new globalThis.WebSocket(wt.webSocketDebuggerUrl);
  await new Promise(function(r) { ws.onopen = r; });

  var pending = {};
  ws.onmessage = function(ev) {
    try { var r = JSON.parse(ev.data); if (r.id && pending[r.id]) { clearTimeout(pending[r.id].t); pending[r.id].r(r); delete pending[r.id]; } } catch(e) {}
  };
  function send(m, p) {
    return new Promise(function(resolve) {
      var id = Math.random();
      var timer = setTimeout(function() { if (pending[id]) { delete pending[id]; resolve(null); } }, 6000);
      pending[id] = { r: resolve, t: timer };
      ws.send(JSON.stringify({ id: id, method: m, params: p || {} }));
    });
  }

  await send('Runtime.enable');
  await new Promise(function(r) { setTimeout(r, 2000); });

  var r0 = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  console.log('Title:', r0 && r0.result ? r0.result.value : 'null');

  var r1 = await send('Runtime.evaluate', { expression: 'document.querySelector(".widget-header")!==null', returnByValue: true });
  console.log('Has .widget-header:', r1 && r1.result ? r1.result.value : 'null');

  if (r1 && r1.result && r1.result.value === true) {
    var r2 = await send('Runtime.evaluate', { expression: 'getComputedStyle(document.querySelector(".widget-header")).getPropertyValue("-webkit-app-region")', returnByValue: true });
    console.log('Region:', r2 && r2.result ? r2.result.value : 'null');

    var r3 = await send('Runtime.evaluate', { expression: 'Array.from(document.querySelectorAll(".widget-header button")).map(function(e){return getComputedStyle(e).getPropertyValue("-webkit-app-region")})', returnByValue: true });
    console.log('Buttons:', r3 && r3.result ? JSON.stringify(r3.result.value) : 'null');
  }

  ws.close();
  process.exit(0);
}
main().catch(function(e) { console.error(e.message); process.exit(1); });
