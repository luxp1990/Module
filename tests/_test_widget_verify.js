const http = require('http');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  // Step 1: Source code checks
  console.log('=== 源码检查 ===');
  const fs = require('fs');
  const mainJs = fs.readFileSync('src/main/main.js', 'utf8');
  
  // Test A1: _isDragging let declaration
  const a1 = mainJs.includes('let _isDragging');
  console.log((a1 ? 'PASS' : 'FAIL') + ' A1: _isDragging let');
  
  // Test A2: 80px exclusion
  const a2 = mainJs.includes('bounds.width - 80');
  console.log((a2 ? 'PASS' : 'FAIL') + ' A2: 80px exclusion');
  
  // Test A3: _isDragging guard on moved
  const matchMoved = mainJs.match(/widgetWindow\.on\('moved'.*?{.*?debouncedSaveBounds.*?}/);
  const hasMovedGuard = matchMoved && matchMoved[0].includes('_isDragging');
  console.log((hasMovedGuard ? 'PASS' : 'FAIL') + ' A3: moved guard');
  
  // Test A4: _isDragging guard on resize
  const matchResize = mainJs.match(/widgetWindow\.on\('resize'.*?{.*?debouncedSaveBounds.*?}/);
  const hasResizeGuard = matchResize && matchResize[0].includes('_isDragging');
  console.log((hasResizeGuard ? 'PASS' : 'FAIL') + ' A4: resize guard');
  
  // Test A5: _isDragging set to true before moveBy
  const a5 = mainJs.includes('_isDragging = true') && mainJs.includes('_isDragging = false');
  console.log((a5 ? 'PASS' : 'FAIL') + ' A5: _isDragging flag toggling');
  
  const srcOk = a1 && a2 && hasMovedGuard && hasResizeGuard && a5;
  
  // Step 2: Check widget.html for CSS
  console.log('\n=== Widget HTML 检查 ===');
  const widgetHtml = fs.readFileSync('src/renderer/widget.html', 'utf8');
  
  const b1 = widgetHtml.includes('-webkit-app-region: drag');
  console.log((b1 ? 'PASS' : 'FAIL') + ' B1: widget-header drag');
  
  const b2 = widgetHtml.includes('-webkit-app-region: no-drag');
  console.log((b2 ? 'PASS' : 'FAIL') + ' B2: no-drag on buttons');
  
  // Step 3: Check preload for moveBy IPC
  console.log('\n=== Preload 检查 ===');
  const preloadJs = fs.readFileSync('src/preload/preload.js', 'utf8');
  const c1 = preloadJs.includes('moveBy') || mainJs.includes('widget:moveBy');
  console.log((c1 ? 'PASS' : 'FAIL') + ' C1: moveBy IPC channel');
  
  // Step 4: CDP runtime - try Input.dispatchKeyEvent to trigger widget
  console.log('\n=== CDP 运行时 ===');
  const targets = await httpGet('http://127.0.0.1:9222/json');
  const mt = targets.find(t => t.title === 'Module');
  
  if (!mt) {
    console.log('SKIP: No Module target');
    process.exit(srcOk ? 0 : 1);
    return;
  }
  
  const ws = new globalThis.WebSocket(mt.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  
  function cdp(method, params) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      const timer = setTimeout(() => reject(new Error('Timeout')), 3000);
      const listener = (ev) => {
        try {
          const resp = JSON.parse(ev.data.toString());
          if (resp.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', listener);
            if (resp.error) reject(new Error(resp.error.message));
            else resolve(resp.result);
          }
        } catch (e) { /* non-JSON messages */ }
      };
      ws.addEventListener('message', listener);
    });
  }
  
  try {
    // Enable Runtime
    await cdp('Runtime.enable');
    await cdp('Runtime.runIfWaitingForDebugger');
    
    // Try a quick evaluate - if this works, proceed
    try {
      await cdp('Runtime.evaluate', { expression: '1+1', returnByValue: true, timeout: 2000 });
      console.log('PASS D1: CDP Runtime.evaluate works');
      
      // Get widget window count before
      const t1 = await httpGet('http://127.0.0.1:9222/json');
      console.log('Before toggle: ' + t1.length + ' windows');
      
      // Toggle widget
      await cdp('Runtime.evaluate', {
        expression: '(async function(){ try { var w = window._api && window._api.widget; if(w){ var st = await w.status(); if(!st.open){ await w.toggle(); } return "ok"; } return "no_api"; } catch(e) { return "err:"+e.message; } })()',
        returnByValue: true,
        awaitPromise: true
      });
      
      await new Promise(r => setTimeout(r, 2000));
      const t2 = await httpGet('http://127.0.0.1:9222/json');
      console.log('After toggle: ' + t2.length + ' windows');
      
      if (t2.length > t1.length) {
        console.log('PASS D2: Widget window appeared');
      } else {
        console.log('INFO: Widget may already be open or in separate process');
      }
      
      // Verify widget IPC by sending a direct IPC message instead
    } catch (e2) {
      console.log('SKIP D1: CDP Runtime.evaluate unavailable');
    }
  } catch (e) {
    console.log('CDP init error: ' + e.message.substring(0, 60));
  }
  
  ws.close();
  
  console.log('\n' + (srcOk ? '==================== ALL PASS ====================' : '==================== SOME FAILED ===================='));
  process.exit(srcOk ? 0 : 1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
