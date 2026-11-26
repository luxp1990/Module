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
let failed = 0;
function assert(c, m) {
  console.log(c ? '  PASS' : '  FAIL', m);
  if (!c) failed++;
}

(async () => {
  let targets;
  try { targets = await httpGet('http://127.0.0.1:9222/json/list'); }
  catch (_) { console.log('SKIP: no CDP'); process.exit(0); }
  let page = targets.find(t => t.title === 'Module');
  if (!page) { console.log('SKIP: no Module'); process.exit(0); }

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
    if (await ev('!!window.ModuleApp.KeyboardController')) break;
    await new Promise(r => setTimeout(r, 100));
  }

  await ev(`document.querySelector('.nav-item[data-view="hierarchy"]').click()`);
  await new Promise(r => setTimeout(r, 100));

  // Esc clear
  const esc = await ev(`(() => {
    const row = document.querySelector('#viewContainer .task-row[data-id]');
    if (!row) return { skip: true };
    window.ModuleApp.TaskController.selectTask(row.dataset.id);
    document.getElementById('viewContainer').focus();
    window.ModuleApp.KeyboardController._onKey(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return { skip: false, selectedId: window.ModuleApp.State.state.selectedId };
  })()`);
  console.log('esc', esc);
  if (!esc.skip) assert(esc.selectedId == null, 'Esc 取消选中');

  // dblclick opens modal
  const dbl = await ev(`(() => {
    const row = document.querySelector('#viewContainer .task-row[data-id]');
    if (!row) return { skip: true };
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const open = !document.getElementById('taskModal').hidden;
    const title = document.getElementById('modalTitle')?.textContent;
    window.ModuleApp.Modal.closeTaskModal();
    return { skip: false, open, title };
  })()`);
  console.log('dbl', dbl);
  if (!dbl.skip) assert(dbl.open && dbl.title === '编辑任务', '双击打开编辑');

  // scrollIntoView exists on select path
  const scroll = await ev(`(() => {
    const rows = [...document.querySelectorAll('#viewContainer .task-row[data-id]')];
    if (rows.length < 2) return { skip: true };
    const last = rows[rows.length - 1];
    const id = last.dataset.id;
    // stub
    let called = false;
    const orig = last.scrollIntoView;
    last.scrollIntoView = function() { called = true; };
    window.ModuleApp.TaskController.selectTask(id);
    last.scrollIntoView = orig;
    return { skip: false, called, selectedId: window.ModuleApp.State.state.selectedId === id };
  })()`);
  console.log('scroll', scroll);
  if (!scroll.skip) assert(scroll.called && scroll.selectedId, 'selectTask 会 scrollIntoView');

  // staysInProjectScope via drag guard API
  const stay = await ev(`window.ModuleApp.ProjectScope.staysInProjectScope(
    [{id:'A',parentId:null},{id:'a1',parentId:'A'}], ['A'], null
  )`);
  assert(stay === false, 'null parent 会离开项目 scope');

  ws.close();
  console.log('\n' + (failed ? 'FAILED ' + failed : 'ALL PASS'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
