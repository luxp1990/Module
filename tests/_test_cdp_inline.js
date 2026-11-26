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
  // Get targets
  const targets = await httpGet('http://127.0.0.1:9222/json');
  const mt = targets.find(t => t.title === 'Module');
  if (!mt) { console.log('FAIL: No Module target'); process.exit(1); return; }
  
  const ws = new globalThis.WebSocket(mt.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  
  function cdp(m, p) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      ws.send(JSON.stringify({id, method: m, params: p||{}}));
      const t = setTimeout(() => { reject(new Error('Timeout')); }, 4000);
      const listener = (ev) => {
        try {
          const resp = JSON.parse(ev.data.toString());
          if (resp.id === id) {
            clearTimeout(t);
            ws.removeEventListener('message', listener);
            if (resp.error) reject(new Error(resp.error.message));
            else resolve(resp.result);
          }
        } catch(e) {}
      };
      ws.addEventListener('message', listener);
    });
  }
  
  try {
    await cdp('Runtime.enable');
    await cdp('Runtime.runIfWaitingForDebugger');
    
    const r1 = await cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    console.log('Title:', r1.result.value);
    
    // Try a simpler approach - just send Input.dispatchKeyEvent to trigger Ctrl+Shift+M
    // First check window state
    const r2 = await cdp('Runtime.evaluate', { expression: '!!window.__MODULE_LOADED__', returnByValue: true });
    console.log('Module loaded:', r2.result.value);
    
    // Check api
    const r3 = await cdp('Runtime.evaluate', { 
      expression: 'window._api && typeof window._api.widget === "object" ? Object.keys(window._api.widget).join(",") : "no_widget_api"', 
      returnByValue: true 
    });
    console.log('Widget API keys:', r3.result.value);
    
    // Try toggling widget
    const r4 = await cdp('Runtime.evaluate', {
      expression: '(async()=>{try{var s=await window._api.widget.status();console.log("widget status",s);if(!s.open){await window._api.widget.toggle()}var s2=await window._api.widget.status();return s2.open?"open":"fail"}catch(e){return "err:"+e.message}})()',
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Widget toggle result:', r4.result.value);
    
    // Check for widget window
    await new Promise(r => setTimeout(r, 2000));
    const t2 = await httpGet('http://127.0.0.1:9222/json');
    console.log('Windows:', t2.length);
    t2.forEach(t => console.log('  ' + t.title));
    
  } catch(e) {
    console.log('CDP Error:', e.message);
  }
  
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
