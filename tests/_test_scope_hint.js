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
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 20000);
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
  let targets = await httpGet('http://127.0.0.1:9222/json/list');
  let page = targets.find(t => t.title === 'Module');
  let ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Page.reload', { ignoreCache: true });
  ws.close();
  await new Promise(r => setTimeout(r, 1800));
  targets = await httpGet('http://127.0.0.1:9222/json/list');
  page = targets.find(t => t.title === 'Module');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const ev = async (expr) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  for (let i = 0; i < 20; i++) {
    if (await ev('!!(window.ModuleApp&&window.ModuleApp.ProjectScope)')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const hint = await ev(`(async () => {
    const api = window.api;
    const State = window.ModuleApp.State;
    const prefix = '__HINT__';
    for (const t of (await api.tasks.getAll()).filter(x => (x.content || '').startsWith(prefix))) {
      try { await api.tasks.delete(t.id); } catch (_) {}
    }
    const tops = (await api.tasks.getAll()).filter(t => !t.parentId);
    const order = tops.length ? Math.max(...tops.map(s => s.order || 0)) + 1 : 0;
    const A = await api.tasks.create({ content: prefix + 'P', parentId: null, order, deadline: null, startDate: null, notes: null });
    const all = await api.tasks.getAll();
    State.patch({ tasks: all, selectedId: null });
    const sel = document.getElementById('projectScopeSelect');
    const roots = window.ModuleApp.ProjectScope.listProjectRoots(all);
    sel.replaceChildren();
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '全部项目'; sel.appendChild(o0);
    for (const t of roots) {
      const o = document.createElement('option'); o.value = t.id; o.textContent = t.content; sel.appendChild(o);
    }
    sel.value = A.id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const text = document.getElementById('quickInputHint')?.textContent || '';
    for (const t of (await api.tasks.getAll()).filter(x => (x.content || '').startsWith(prefix))) {
      try { await api.tasks.delete(t.id); } catch (_) {}
    }
    await api.config.update({ projectScopeIds: [] });
    State.patch({ projectScopeIds: [] });
    return text;
  })()`);
  console.log('hint=', hint);
  const ok = hint.includes('回车添加到');
  console.log(ok ? 'PASS' : 'FAIL');
  ws.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
