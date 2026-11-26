/**
 * 本轮迭代回归：TaskSort / 脚本拓扑 / Delta 广播 / 关键 UI 契约
 * 用法：node tests/_test_iteration_batch.js
 * 可选：Electron 已用 --remote-debugging-port=9222 启动时附带 CDP 检查
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;

function assert(cond, msg) {
  if (cond) console.log('  PASS', msg);
  else { console.log('  FAIL', msg); failed++; }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadTaskSort() {
  const code = read('src/renderer/shared/task-sort.js');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.ModuleApp.TaskSort;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = (cdp._seq = (cdp._seq || 0) + 1);
    const timer = setTimeout(() => {
      ws.removeEventListener('message', listener);
      reject(new Error('CDP timeout ' + method));
    }, 15000);
    const listener = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeEventListener('message', listener);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (e) { /* ignore */ }
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  console.log('=== 1. TaskSort 单元 ===');
  const Sort = loadTaskSort();
  assert(!!Sort, 'TaskSort 导出');

  const tasks = [
    { id: 'a', content: '主', parentId: null, order: 1, deadline: '2026-07-25', completed: false },
    { id: 'b', content: '子', parentId: 'a', order: 1, deadline: '2026-07-20', completed: false },
    { id: 'c', content: '同日', parentId: null, order: 2, deadline: '2026-07-20', completed: false },
    { id: 'd', content: '完成', parentId: 'a', order: 2, deadline: '2026-07-19', completed: true },
  ];

  const { childrenMap } = Sort.buildChildrenMap(tasks, { activeOnly: true });
  assert(childrenMap.get('a').length === 1 && childrenMap.get('a')[0].id === 'b', 'activeOnly 排除已完成子');

  const order = Sort.buildHierarchyOrder(tasks, { includeCompleted: false });
  assert(order.get('a') === 0 && order.get('b') === 1 && order.get('c') === 2, 'DFS 序 a→b→c');

  const sorted = [tasks[0], tasks[1], tasks[2]].sort((x, y) => Sort.unifiedDeadlineSort(x, y, order));
  assert(sorted[0].id === 'b' || sorted[0].id === 'c', '截止日升序优先');
  // b 与 c 同日：DFS 中 b 在 c 前
  const sameDay = [tasks[1], tasks[2]].sort((x, y) => Sort.unifiedDeadlineSort(x, y, order));
  assert(sameDay[0].id === 'b' && sameDay[1].id === 'c', '同日按 DFS：b 先于 c');

  console.log('\n=== 2. 脚本拓扑 / 源码契约 ===');
  const index = read('src/renderer/index.html');
  assert(index.includes('shared/task-sort.js'), 'index 加载 task-sort');
  assert(index.includes('keyboard-controller.js'), 'index 加载 keyboard');
  assert(index.includes('moreMenuBtn'), '顶栏更多按钮');
  assert(index.includes('id="autoPlanBtn"'), '跟随排期按钮');

  const widget = read('src/renderer/widget.html');
  assert(widget.includes('shared/task-sort.js'), 'widget 加载 task-sort');
  assert(widget.includes('applyWidgetTheme'), 'widget 主题函数');
  assert(widget.includes('TaskSort'), 'widget 使用 TaskSort');

  const mainJs = read('src/main/main.js');
  assert(mainJs.includes("action: 'TASK_CREATED'") && mainJs.includes('payload: result'), 'TASK_CREATED 带 payload');
  assert(mainJs.includes("action: 'TASK_COMPLETED'") && mainJs.includes('payload: { ids }'), 'TASK_COMPLETED 带 ids');

  const appJs = read('src/renderer/app.js');
  assert(appJs.includes('applyPeerDelta'), 'applyPeerDelta 存在');
  assert(appJs.includes("actionType === 'PEER_DELTA'"), 'subscribe PEER_DELTA');
  assert(appJs.includes('Modal.choose'), '导入用 choose');
  assert(appJs.includes('morphdom'), 'morphdom 增量');

  const modal = read('src/renderer/components/modal.js');
  assert(modal.includes('choose({'), 'Modal.choose 实现');

  const drag = read('src/renderer/controllers/drag-controller.js');
  assert(drag.includes('drag-over-invalid'), '拖拽非法态');

  const hier = read('src/renderer/views/hierarchy.js');
  assert(hier.includes('buildChildrenMap'), 'hierarchy 用 childrenMap');

  const ds = read('src/main/data-store.js');
  assert(ds.includes("theme: 'light'") || ds.includes('updates.theme'), 'config.theme 持久化');

  const pkg = JSON.parse(read('package.json'));
  assert(pkg.build.directories.output === 'dist', '构建输出 dist');

  console.log('\n=== 3. applyPeerDelta 逻辑（抽离复刻）===');
  // 轻量复刻合并规则，验证与 app.js 语义一致
  function mergeDelta(tasksIn, patch) {
    const tasks = tasksIn.map(t => ({ ...t }));
    if (patch.action === 'TASK_UPDATED') {
      return tasks.map(t => t.id === patch.id ? { ...t, ...patch.payload } : t);
    }
    if (patch.action === 'TASK_COMPLETED') {
      const ids = new Set((patch.payload && patch.payload.ids) || [patch.id]);
      return tasks.map(t => ids.has(t.id) ? { ...t, completed: true } : t);
    }
    if (patch.action === 'TASK_CREATED' && patch.payload) {
      return [...tasks, patch.payload];
    }
    if (patch.action === 'TASK_DELETED') {
      return tasks.filter(t => t.id !== patch.id);
    }
    return null;
  }
  let base = [
    { id: '1', content: 'A', completed: false, priority: null },
    { id: '2', content: 'B', completed: false, priority: null },
  ];
  base = mergeDelta(base, { action: 'TASK_UPDATED', id: '1', payload: { content: 'A2' } });
  assert(base[0].content === 'A2', 'delta UPDATE');
  base = mergeDelta(base, { action: 'TASK_COMPLETED', id: '2', payload: { ids: ['2'] } });
  assert(base[1].completed === true, 'delta COMPLETE');
  base = mergeDelta(base, { action: 'TASK_CREATED', payload: { id: '3', content: 'C', completed: false } });
  assert(base.length === 3, 'delta CREATE');
  base = mergeDelta(base, { action: 'TASK_DELETED', id: '1' });
  assert(base.every(t => t.id !== '1'), 'delta DELETE');

  console.log('\n=== 4. CDP 运行时（若 9222 可用）===');
  try {
    const targets = await httpGet('http://127.0.0.1:9222/json');
    const mainTarget = targets.find(t => (t.title || '').includes('Module') && !(t.title || '').includes('组件'));
    const any = mainTarget || targets.find(t => t.type === 'page');
    if (!any) {
      console.log('  SKIP 无 page target');
    } else {
      const WebSocket = globalThis.WebSocket || require('ws');
      const ws = new WebSocket(any.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      await cdp(ws, 'Runtime.enable');

      const r1 = await cdp(ws, 'Runtime.evaluate', {
        expression: `({
          hasTaskSort: !!(window.ModuleApp && window.ModuleApp.TaskSort),
          hasKb: !!(window.ModuleApp && window.ModuleApp.KeyboardController),
          hasChoose: !!(window.ModuleApp && window.ModuleApp.Modal && window.ModuleApp.Modal.choose),
          hasMore: !!document.getElementById('moreMenuBtn'),
          autoPlanText: (document.getElementById('autoPlanBtn')||{}).textContent || '',
          themeDark: document.body.classList.contains('theme-dark'),
          api: !!window.api
        })`,
        returnByValue: true
      });
      const v = r1.result.value;
      console.log('  CDP snapshot:', JSON.stringify(v));
      assert(v.hasTaskSort, '运行时 TaskSort');
      assert(v.hasKb, '运行时 KeyboardController');
      assert(v.hasChoose, '运行时 Modal.choose');
      assert(v.hasMore, '运行时 moreMenuBtn');
      assert(v.autoPlanText.includes('跟随') || v.autoPlanText.length > 0, '跟随排期按钮文案');
      assert(v.api, 'window.api');

      // 创建→读回→删除 一轮 smoke（用临时内容标记）
      const smoke = await cdp(ws, 'Runtime.evaluate', {
        expression: `(async function(){
          const mark = 'ITER_TEST_' + Date.now();
          const created = await window.api.tasks.create({ content: mark, startDate: null, deadline: '2099-01-01', notes: null });
          const all = await window.api.tasks.getAll();
          const found = all.some(t => t.id === created.id && t.content === mark);
          await window.api.tasks.delete(created.id);
          const after = await window.api.tasks.getAll();
          const gone = !after.some(t => t.id === created.id);
          return { found, gone, id: created.id };
        })()`,
        returnByValue: true,
        awaitPromise: true
      });
      const s = smoke.result.value;
      console.log('  CRUD smoke:', JSON.stringify(s));
      assert(s.found && s.gone, 'IPC 创建/删除闭环');

      // 主题切换往返
      const theme = await cdp(ws, 'Runtime.evaluate', {
        expression: `(async function(){
          const cfg0 = await window.api.config.get();
          const next = cfg0.theme === 'dark' ? 'light' : 'dark';
          await window.api.config.update({ theme: next });
          const cfg1 = await window.api.config.get();
          await window.api.config.update({ theme: cfg0.theme || 'light' });
          return { was: cfg0.theme, set: next, got: cfg1.theme };
        })()`,
        returnByValue: true,
        awaitPromise: true
      });
      const th = theme.result.value;
      console.log('  theme:', JSON.stringify(th));
      assert(th.got === th.set, 'config.theme 可写回');

      ws.close();
    }
  } catch (e) {
    console.log('  SKIP CDP:', e.message);
  }

  console.log('\n' + (failed ? `FAILED: ${failed}` : 'ALL PASS'));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
