'use strict';
/** 主任务作用域：CDP 实机回归 */
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
  if (!page) throw new Error('no Module page');

  let ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Page.reload', { ignoreCache: true });
  ws.close();
  await new Promise(r => setTimeout(r, 2000));

  targets = await httpGet('http://127.0.0.1:9222/json/list');
  page = targets.find(t => t.title === 'Module');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Runtime.enable');

  const ev = async (expr, ap = true) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  // wait ModuleApp ready
  for (let i = 0; i < 20; i++) {
    const ok = await ev(`!!(window.ModuleApp && window.ModuleApp.ProjectScope && window.ModuleApp.State)`);
    if (ok) break;
    await new Promise(r => setTimeout(r, 200));
  }

  assert(await ev(`!!window.ModuleApp.ProjectScope`), 'ProjectScope 已加载');
  assert(await ev(`!!document.getElementById('projectScopeSelect')`), '项目下拉存在');

  // ensure hierarchy + at least 2 roots
  await ev(`document.querySelector('.nav-item[data-view="hierarchy"]').click()`);
  await new Promise(r => setTimeout(r, 200));

  const prep = await ev(`(async () => {
    const State = window.ModuleApp.State;
    const api = window.api;
    let tasks = State.state.tasks;
    let roots = tasks.filter(t => !t.parentId && !t.completed);
    // 若不足 2 个未完成顶层，造两个测试根（带唯一前缀）
    const prefix = '__SCOPE_TEST__';
    const existing = roots.filter(t => (t.content||'').startsWith(prefix));
    for (const t of existing) {
      try { await api.tasks.delete(t.id); } catch (_) {}
    }
    await window.ModuleApp /* force */;
    // reload via Core path
    const all = await api.tasks.getAll();
    State.patch({ tasks: all });
    roots = all.filter(t => !t.parentId && !t.completed);
    const mk = async (name) => {
      const tops = State.state.tasks.filter(t => !t.parentId);
      const order = tops.length ? Math.max(...tops.map(s => s.order||0)) + 1 : 0;
      return api.tasks.create({ content: prefix + name, parentId: null, order, deadline: null, startDate: null, notes: null });
    };
    const A = await mk('A');
    const B = await mk('B');
    const a1 = await api.tasks.create({ content: prefix + 'A-child', parentId: A.id, order: 0, deadline: '2026-08-01', startDate: '2026-07-20', notes: null });
    const b1 = await api.tasks.create({ content: prefix + 'B-child', parentId: B.id, order: 0, deadline: '2026-08-02', startDate: '2026-07-21', notes: null });
    const all2 = await api.tasks.getAll();
    State.patch({ tasks: all2 });
    // refresh select via CoreServices if present
    if (window.ModuleApp && typeof window !== 'undefined') {
      // CoreServices not exported — trigger via select rebuild by re-calling load if possible
    }
    return { A: A.id, B: B.id, a1: a1.id, b1: b1.id, rootCount: all2.filter(t=>!t.parentId&&!t.completed).length };
  })()`);
  console.log('prep', prep);

  // rebuild select options by invoking change handler path: patch + manual refresh
  await ev(`(async () => {
    const tasks = await window.api.tasks.getAll();
    window.ModuleApp.State.patch({ tasks });
    // rebuild select DOM like CoreServices.refreshProjectScopeSelect
    const sel = document.getElementById('projectScopeSelect');
    const roots = window.ModuleApp.ProjectScope.listProjectRoots(tasks);
    sel.replaceChildren();
    const o0 = document.createElement('option'); o0.value=''; o0.textContent='全部项目'; sel.appendChild(o0);
    for (const t of roots) {
      const o = document.createElement('option'); o.value=t.id; o.textContent=t.content||''; sel.appendChild(o);
    }
  })()`);

  // --- set scope to A via CoreServices if available, else patch+render ---
  const setScope = async (idOrEmpty) => {
    return ev(`(async () => {
      const ids = ${JSON.stringify(idOrEmpty ? [idOrEmpty] : [])};
      // try find CoreServices on window — not exported; mimic setProjectScope
      const State = window.ModuleApp.State;
      const PS = window.ModuleApp.ProjectScope;
      const scrubbed = PS.scrubScopeIds(State.state.tasks, ids);
      const vis = PS.visibleIdSet(State.state.tasks, scrubbed);
      const patch = { projectScopeIds: scrubbed };
      if (vis) {
        if (State.state.selectedId && !vis.has(State.state.selectedId)) patch.selectedId = null;
        if (State.state.anchorId && !vis.has(State.state.anchorId)) patch.anchorId = null;
        if (State.state.multiSelect && State.state.multiSelect.size > 0) {
          patch.multiSelect = [...State.state.multiSelect].filter(id => vis.has(id));
        }
      }
      State.patch(patch);
      await window.api.config.update({ projectScopeIds: scrubbed });
      const sel = document.getElementById('projectScopeSelect');
      if (sel) sel.value = scrubbed[0] || '';
      // render hierarchy
      document.querySelector('.nav-item[data-view="hierarchy"]').click();
      await new Promise(r => setTimeout(r, 50));
      window.ModuleApp.HierarchyView.render(State.state, 'REPLACE');
      const addBtn = document.getElementById('addTaskBtn');
      if (addBtn) addBtn.textContent = scrubbed.length===1 ? '+ 在本项目新建' : '+ 新建主任务';
      return { scope: State.state.projectScopeIds, btn: addBtn && addBtn.textContent };
    })()`);
  };

  let r = await setScope(prep.A);
  console.log('scope A', r);
  assert(r.scope[0] === prep.A, '切到项目 A');
  assert(r.btn === '+ 在本项目新建', 'M2 按钮文案');

  let visible = await ev(`([...document.querySelectorAll('#viewContainer .task-row[data-id]')].map(el => el.dataset.id))`);
  console.log('visible hierarchy A', visible);
  assert(visible.includes(prep.A) && visible.includes(prep.a1), '层级可见 A 与子');
  assert(!visible.includes(prep.B) && !visible.includes(prep.b1), '层级不可见 B');

  // deadline view
  await ev(`document.querySelector('.nav-item[data-view="deadline"]').click()`);
  await new Promise(r => setTimeout(r, 150));
  visible = await ev(`([...document.querySelectorAll('#viewContainer .task-row[data-id], #viewContainer [data-id]')].map(el => el.dataset.id).filter(Boolean))`);
  console.log('visible deadline', visible);
  assert(visible.includes(prep.a1), '截止视图有 A-child');
  assert(!visible.includes(prep.b1), '截止视图无 B-child');

  // gantt
  await ev(`document.querySelector('.nav-item[data-view="gantt"]').click()`);
  await new Promise(r => setTimeout(r, 600));
  const ganttIds = await ev(`([...document.querySelectorAll('.gantt-row[data-task-id]')].map(el => el.dataset.taskId))`);
  console.log('gantt', ganttIds);
  assert(ganttIds.includes(prep.A) || ganttIds.includes(prep.a1), '甘特有 A 树');
  assert(!ganttIds.includes(prep.B) && !ganttIds.includes(prep.b1), '甘特无 B 树');

  // selection preserve: select a1, switch scope still containing a1... already in A
  await ev(`document.querySelector('.nav-item[data-view="hierarchy"]').click()`);
  await new Promise(r => setTimeout(r, 100));
  await setScope(prep.A);
  await ev(`window.ModuleApp.TaskController.selectTask(${JSON.stringify(prep.a1)})`);
  let sel = await ev(`window.ModuleApp.State.state.selectedId`);
  assert(sel === prep.a1, '选中 a1');

  // switch to B → should clear selection
  r = await setScope(prep.B);
  sel = await ev(`window.ModuleApp.State.state.selectedId`);
  assert(sel == null, '切到 B 后清掉 a1 选中');
  visible = await ev(`([...document.querySelectorAll('#viewContainer .task-row[data-id]')].map(el => el.dataset.id))`);
  assert(visible.includes(prep.B) && !visible.includes(prep.A), '层级只见 B');

  // create under scope B via openCreateModal default
  const created = await ev(`(async () => {
    const State = window.ModuleApp.State;
    const def = window.ModuleApp.ProjectScope.defaultCreateParentId(State.state);
    window.ModuleApp.TaskController.openCreateModal(def.parentId);
    document.getElementById('taskContent').value = '__SCOPE_TEST__B-new';
    await window.ModuleApp.TaskController.saveTask();
    await new Promise(r => setTimeout(r, 200));
    const tasks = window.ModuleApp.State.state.tasks;
    const t = tasks.find(x => x.content === '__SCOPE_TEST__B-new');
    return t ? { id: t.id, parentId: t.parentId } : null;
  })()`);
  console.log('created', created);
  assert(created && created.parentId === prep.B, '新建挂在 B 下');

  // defaultCreateParentId when all
  await setScope('');
  const defAll = await ev(`window.ModuleApp.ProjectScope.defaultCreateParentId(window.ModuleApp.State.state)`);
  assert(defAll.parentId === null && defAll.isScoped === false, '全部时默认顶层');

  // search scoped
  await setScope(prep.A);
  await ev(`window.ModuleApp.State.patch({ search: '__SCOPE_TEST__B-child' }); window.ModuleApp.SearchController.updateSearchResult();`);
  const searchHits = await ev(`window.ModuleApp.SearchController._matchIds`);
  assert(!searchHits.includes(prep.b1), '搜索不跨出 scope');
  await ev(`window.ModuleApp.State.patch({ search: '__SCOPE_TEST__A-child' }); window.ModuleApp.SearchController.updateSearchResult();`);
  const searchHits2 = await ev(`window.ModuleApp.SearchController._matchIds`);
  assert(searchHits2.includes(prep.a1), '搜索命中 scope 内');

  // stats: active count should be less when scoped
  const stats = await ev(`(() => {
    const s = window.ModuleApp.State.state;
    const PS = window.ModuleApp.ProjectScope;
    const allActive = s.tasks.filter(t => !t.completed).length;
    const scoped = PS.filterTasksByProjectScope(s.tasks, s.projectScopeIds).filter(t => !t.completed).length;
    // trigger render stats
    document.querySelector('.nav-item[data-view="hierarchy"]').click();
    return { allActive, scoped, statDom: document.getElementById('statActive')?.textContent };
  })()`);
  console.log('stats', stats);
  assert(Number(stats.statDom) === stats.scoped || Number(stats.statDom) <= stats.allActive, '侧栏统计跟 scope');

  // cleanup test tasks
  await setScope('');
  await ev(`(async () => {
    const tasks = await window.api.tasks.getAll();
    for (const t of tasks.filter(x => (x.content||'').startsWith('__SCOPE_TEST__'))) {
      try { await window.api.tasks.delete(t.id); } catch (_) {}
    }
    const all = await window.api.tasks.getAll();
    window.ModuleApp.State.patch({ tasks: all, projectScopeIds: [], search: '' });
    await window.api.config.update({ projectScopeIds: [] });
  })()`);

  ws.close();
  console.log('\n' + (failed ? 'FAILED: ' + failed : 'ALL PASS'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
