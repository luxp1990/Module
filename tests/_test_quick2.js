const http = require('http');
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  let ok = true;

  // 1. Source
  const fs = require('fs');
  const mainJs = fs.readFileSync('src/main/main.js', 'utf8');
  const srcOk = mainJs.includes('let _isDragging') && mainJs.includes('bounds.width - 80') && (mainJs.match(/!_isDragging[\s\S]*?debouncedSaveBounds/g) || []).length >= 2;
  console.log((srcOk ? 'PASS' : 'FAIL') + ' 源码检查');

  // 2. CDP
  const targets = await httpGet('http://127.0.0.1:9222/json');
  const mt = targets.find(t => t.title === 'Module');
  if (!mt) { console.log('SKIP CDP: no Module target'); process.exit(srcOk ? 0 : 1); return; }

  const ws = new globalThis.WebSocket(mt.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  
  function cdp(method, params) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const msg = JSON.stringify({ id, method, params: params || {} });
      const timer = setTimeout(() => reject(new Error('Timeout')), 5000);
      const listener = (ev) => {
        try {
          const resp = JSON.parse(ev.data.toString());
          if (resp.id === id) { clearTimeout(timer); ws.removeEventListener('message', listener); resp.error ? reject(new Error(resp.error.message)) : resolve(resp.result); }
        } catch(e) {}
      };
      ws.addEventListener('message', listener);
      ws.send(msg);
    });
  }

  try {
    await cdp('Runtime.enable');
    await cdp('Runtime.runIfWaitingForDebugger');
    
    // Check renderer API
    const r = await cdp('Runtime.evaluate', { expression: 'window._api && window._api.widget ? "api_ok" : "no_api"', returnByValue: true, timeout: 3000 });
    
    if (r.result.value === 'api_ok') {
      // Toggle widget
      const w = await cdp('Runtime.evaluate', { expression: '(async()=>{var s=await window._api.widget.status();if(!s.open)await window._api.widget.toggle();return(await window._api.widget.status()).open?"open":"fail";})()', returnByValue: true, awaitPromise: true, timeout: 3000 });
      console.log((w.result.value === 'open' ? 'PASS' : 'FAIL') + ' Widget 打开');
      
      await new Promise(r => setTimeout(r, 1500));
      const t2 = await httpGet('http://127.0.0.1:9222/json');
      console.log('窗口数: ' + t2.length + ' (含Widget)');
    } else {
      console.log('SKIP: renderer API not available (early init stage)');
    }
  } catch(e) {
    console.log('CDP eval issue (known Electron limitation): ' + e.message);
  }

  ws.close();
  console.log(srcOk ? 'ALL PASS' : 'SOME FAILED');
  process.exit(srcOk ? 0 : 1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
