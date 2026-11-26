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
  
  process.stdout.write('Widget found: ' + wt.title + '\n');
  
  var ws = new globalThis.WebSocket(wt.webSocketDebuggerUrl);
  await new Promise(function(r) { ws.onopen = r; });
  process.stdout.write('Connected\n');
  
  var pending = {};
  ws.onmessage = function(ev) {
    try {
      var r = JSON.parse(ev.data.toString());
      if (r.id && pending[r.id]) { clearTimeout(pending[r.id].t); pending[r.id].r(r); delete pending[r.id]; }
    } catch(e) {}
  };
  function send(m, p) {
    return new Promise(function(resolve) {
      var id = Math.random();
      var timer = setTimeout(function() { if (pending[id]) { delete pending[id]; resolve(null); } }, 4000);
      pending[id] = { r: resolve, t: timer };
      ws.send(JSON.stringify({ id: id, method: m, params: p || {} }));
    });
  }
  
  await send('Runtime.enable');
  
  var r1 = await send('Runtime.evaluate', { expression: 'document.querySelector(".widget-header")!==null', returnByValue: true });
  var hasHeader = r1 && r1.result ? r1.result.value : false;
  process.stdout.write('Has header: ' + hasHeader + '\n');
  
  if (hasHeader) {
    var r2 = await send('Runtime.evaluate', { expression: 'getComputedStyle(document.querySelector(".widget-header")).getPropertyValue("-webkit-app-region")', returnByValue: true });
    var region = r2 && r2.result ? r2.result.value : 'NO_RESPONSE';
    process.stdout.write('Region: ' + region + '\n');
    
    var r3 = await send('Runtime.evaluate', { expression: 'Array.from(document.querySelectorAll(".widget-header button,.widget-header .note-actions")).map(function(e){return getComputedStyle(e).getPropertyValue("-webkit-app-region")})', returnByValue: true });
    var btnRegions = r3 && r3.result ? r3.result.value : null;
    process.stdout.write('Button regions: ' + JSON.stringify(btnRegions) + '\n');
  }
  
  ws.close();
  process.exit(0);
}
main().catch(function(e) { process.stderr.write(e.message + '\n'); process.exit(1); });
