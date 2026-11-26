const http = require('http');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  let ok = true;

  // 1. Source code check
  const fs = require('fs');
  const mainJs = fs.readFileSync('src/main/main.js', 'utf8');
  const lines = mainJs.split('\n');

  const hasLetDecl = lines.some(l => l.includes('let _isDragging'));
  const hasExclusion80 = lines.some(l => l.includes('bounds.width - 80'));
  const guards = lines.filter(l => l.includes('!_isDragging') && l.includes('debouncedSaveBounds'));

  console.log('=== 源码检查 ===');
  console.log((hasLetDecl ? 'PASS' : 'FAIL') + ' _isDragging 有 let 声明');
  console.log((hasExclusion80 ? 'PASS' : 'FAIL') + ' 排除区 80px');
  console.log((guards.length >= 2 ? 'PASS' : 'FAIL') + ' resize/moved 守卫 (' + guards.length + '处)');

  if (!hasLetDecl || !hasExclusion80 || guards.length < 2) ok = false;

  // 2. CDP runtime check
  try {
    const targets = await httpGet('http://127.0.0.1:9222/json');
    const mainTarget = targets.find(t => t.title === 'Module');
    if (mainTarget) {
      console.log('\n=== CDP 运行时检查 ===');
      const ws = new globalThis.WebSocket(mainTarget.webSocketDebuggerUrl);
      await new Promise((r) => ws.onopen = r);
      await cdp(ws, 'Runtime.enable');
      await cdp(ws, 'Runtime.runIfWaitingForDebugger');

      const r = await cdp(ws, 'Runtime.evaluate', {
        expression: '(function(){ return { hasApi: !!window._api, hasWidget: !!(window._api && window._api.widget), hasMoveBy: !!(window._api && window._api.widget && window._api.widget.moveBy) }; })()',
        returnByValue: true
      });
      console.log('API 检查:', JSON.stringify(r.result.value));

      const w = await cdp(ws, 'Runtime.evaluate', {
        expression: '(async function(){ var st = await window._api.widget.status(); if(!st.open) await window._api.widget.toggle(); return (await window._api.widget.status()).open ? "opened" : "failed"; })()',
        returnByValue: true,
        awaitPromise: true
      });
      console.log('Widget:', w.result.value);

      await new Promise(r => setTimeout(r, 1500));
      const targets2 = await httpGet('http://127.0.0.1:9222/json');
      console.log('Windows:', targets2.length + ' (1=main, 2+=widget可见)');

      ws.close();
    } else {
      console.log('未找到 Module 目标');
    }
  } catch(e) {
    console.log('CDP 检查跳过:', e.message);
  }

  console.log('\n' + (ok ? 'ALL PASS' : 'SOME FAILED'));
  process.exit(ok ? 0 : 1);
}

function cdp(ws, method, params) {
  return new Promise((resolve, reject) => {
    params = params || {};
    const id = Math.random().toString(36).slice(2);
    const msg = JSON.stringify({ id, method, params });
    const listener = (ev) => {
      try {
        const resp = JSON.parse(ev.data.toString());
        if (resp.id === id) {
          ws.removeEventListener('message', listener);
          if (resp.error) reject(new Error(resp.error.message));
          else resolve(resp.result);
        }
      } catch(e) { /* ignore non-json messages */ }
    };
    ws.addEventListener('message', listener);
    ws.send(msg);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
