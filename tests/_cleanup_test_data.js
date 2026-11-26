'use strict';
const http = require('http');
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = (cdp._seq = (cdp._seq || 0) + 1);
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 15000);
    const listener = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeEventListener('message', listener);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (_) {}
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
(async () => {
  const targets = await httpGet('http://127.0.0.1:9222/json/list');
  const page = targets.find(t => t.title === 'Module');
  if (!page) throw new Error('no Module');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Runtime.enable');
  const r = await cdp(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const all = await window.api.tasks.getAll();
      for (const t of all) {
        const c = t.content || '';
        if (c.includes('SEARCH_IT_') || c.includes('PROBE_') || c.includes('ITER_TEST_')) {
          try { await window.api.tasks.delete(t.id); } catch (e) {}
        }
      }
      const tasks = await window.api.tasks.getAll();
      window.ModuleApp.State.patch({ tasks });
      document.querySelector('.nav-item[data-view="hierarchy"]').click();
      await window.api.config.update({ theme: 'light' });
      return { n: tasks.length };
    })()`,
    returnByValue: true,
    awaitPromise: true
  });
  console.log('cleaned', r.result.value);
  ws.close();
})().catch(e => { console.error(e); process.exit(1); });
