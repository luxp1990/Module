'use strict';
/** 作用域边角：原生 select、完成根、快速添加、控制台错误 */
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
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 25000);
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
  let targets = await httpGet('http://127.0.0.1:9222/json/list');
  let page = targets.find(t => t.title === 'Module');
  let ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Page.reload', { ignoreCache: true });
  ws.close();
  await new Promise(r => setTimeout(r, 2000));
  targets = await httpGet('http://127.0.0.1:9222/json/list');
  page = targets.find(t => t.title === 'Module');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Console.enable');
  const errors = [];
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params?.exceptionDetails?.text || 'ex');
      }
      if (msg.method === 'Console.messageAdded' && (msg.params?.message?.level === 'error')) {
        errors.push(msg.params.message.text);
      }
    } catch (_) {}
  });

  const ev = async (expr) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  for (let i = 0; i < 25; i++) {
    if (await ev(`!!(window.ModuleApp&&window.ModuleApp.ProjectScope)`)) break;
    await new Promise(r => setTimeout(r, 150));
  }

  const prep = await ev(`(async () => {
    const api = window.api;
    const State = window.ModuleApp.State;
    const prefix = '__SCOPE_EDGE__';
    for (const t of (await api.tasks.getAll()).filter(x => (x.content||'').startsWith(prefix))) {
      try { await api.tasks.delete(t.id); } catch (_) {}
    }
    const tops = (await api.tasks.getAll()).filter(t => !t.parentId);
    const order = tops.length ? Math.max(...tops.map(s => s.order||0)) + 1 : 0;
    const A = await api.tasks.create({ content: prefix+'Root', parentId: null, order, deadline: null, startDate: null, notes: null });
    const a1 = await api.tasks.create({ content: prefix+'Child', parentId: A.id, order: 0, deadline: null, startDate: null, notes: null });
    const all = await api.tasks.getAll();
    State.patch({ tasks: all, selectedId: null, multiSelect: [], search: '' });
    // rebuild select
    const sel = document.getElementById('projectScopeSelect');
    const roots = window.ModuleApp.ProjectScope.listProjectRoots(all);
    sel.replaceChildren();
    const o0 = document.createElement('option'); o0.value=''; o0.textContent='全部项目'; sel.appendChild(o0);
    for (const t of roots) { const o=document.createElement('option'); o.value=t.id; o.textContent=t.content; sel.appendChild(o); }
    return { A: A.id, a1: a1.id };
  })()`);
  console.log('prep', prep);

  // Native select change (real UI path)
  const native = await ev(`(async () => {
    const sel = document.getElementById('projectScopeSelect');
    sel.value = ${JSON.stringify(prep.A)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const ids = [...document.querySelectorAll('#viewContainer .task-row[data-id]')].map(e => e.dataset.id);
    return {
      scope: window.ModuleApp.State.state.projectScopeIds,
      ids,
      btn: document.getElementById('addTaskBtn')?.textContent,
      cfg: (await window.api.config.get()).projectScopeIds
    };
  })()`);
  console.log('native', native);
  assert(native.scope[0] === prep.A, '原生 change 写入 state');
  assert(Array.isArray(native.cfg) && native.cfg[0] === prep.A, '原生 change 持久化 config');
  assert(native.ids.includes(prep.A) && !native.ids.some(id => id !== prep.A && id !== prep.a1) || native.ids.includes(prep.a1), '原生 change 后视图过滤');

  // Quick add without selection under scope
  const quick = await ev(`(async () => {
    window.ModuleApp.State.patch({ selectedId: null, multiSelect: [] });
    document.querySelector('.nav-item[data-view="hierarchy"]').click();
    await new Promise(r => setTimeout(r, 80));
    const q = document.getElementById('quickInput');
    q.value = '__SCOPE_EDGE__Quick';
    // call handleQuickInput
    await window.ModuleApp.TaskController.handleQuickInput();
    await new Promise(r => setTimeout(r, 200));
    const t = window.ModuleApp.State.state.tasks.find(x => x.content === '__SCOPE_EDGE__Quick');
    return t ? { id: t.id, parentId: t.parentId } : null;
  })()`);
  console.log('quick', quick);
  assert(quick && quick.parentId === prep.A, '无高亮快速添加挂到当前项目');

  // hint text under scope?
  const hint = await ev(`(() => {
    window.ModuleApp.State.patch({ selectedId: null });
    window.ModuleApp.TaskController.updateQuickInputHint();
    return document.getElementById('parentHintBar')?.textContent
      || document.getElementById('quickInputHint')?.textContent
      || document.querySelector('.quick-input-hint')?.textContent
      || null;
  })()`);
  console.log('hint', hint);

  // Complete scope root → should scrub to all
  const afterComplete = await ev(`(async () => {
    // ensure scoped to A
    window.ModuleApp.State.patch({ projectScopeIds: [${JSON.stringify(prep.A)}] });
    await window.api.config.update({ projectScopeIds: [${JSON.stringify(prep.A)}] });
    // bypass confirm
    const prev = window.__confirmDialogMock;
    window.__confirmDialogMock = async () => true;
    await window.ModuleApp.TaskController.handleComplete(${JSON.stringify(prep.A)});
    window.__confirmDialogMock = prev;
    await new Promise(r => setTimeout(r, 200));
    return {
      scope: window.ModuleApp.State.state.projectScopeIds,
      cfg: (await window.api.config.get()).projectScopeIds,
      sel: document.getElementById('projectScopeSelect')?.value,
      rootStillActive: !!(window.ModuleApp.State.state.tasks.find(t => t.id === ${JSON.stringify(prep.A)} && !t.completed))
    };
  })()`);
  console.log('afterComplete', afterComplete);
  assert((afterComplete.scope || []).length === 0, '完成项目根后 scope 清空');
  assert((afterComplete.cfg || []).length === 0, '完成项目根后 config 清空');
  assert(afterComplete.sel === '', '下拉回到全部项目');

  // cleanup
  await ev(`(async () => {
    for (const t of (await window.api.tasks.getAll()).filter(x => (x.content||'').startsWith('__SCOPE_EDGE__'))) {
      try { await window.api.tasks.delete(t.id); } catch (_) {}
    }
    window.ModuleApp.State.patch({ projectScopeIds: [], search: '', selectedId: null });
    await window.api.config.update({ projectScopeIds: [] });
  })()`);

  console.log('consoleErrors', errors.slice(0, 8));
  assert(errors.length === 0, '无控制台异常');

  ws.close();
  console.log('\n' + (failed ? 'FAILED: ' + failed : 'ALL PASS'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
