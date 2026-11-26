/**
 * 深度 CDP：控制台错误、视图渲染、搜索/键盘、Modal.choose、widget 主题
 */
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
    const timer = setTimeout(() => {
      ws.removeEventListener('message', listener);
      reject(new Error('timeout ' + method));
    }, 20000);
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

async function evalMain(ws, expression, awaitPromise = false) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (r.exceptionDetails) {
    throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  }
  return r.result.value;
}

let failed = 0;
function assert(c, m) {
  console.log(c ? '  PASS' : '  FAIL', m);
  if (!c) failed++;
}

async function main() {
  const targets = await httpGet('http://127.0.0.1:9222/json/list');
  const page = targets.find(t => t.title === 'Module');
  if (!page) throw new Error('Module page not found');

  const consoleErrors = [];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Console.enable').catch(() => {});
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params.exceptionDetails?.text || 'exception');
      }
      if (msg.method === 'Console.messageAdded' && (msg.params.message?.level === 'error')) {
        consoleErrors.push(msg.params.message.text);
      }
    } catch (_) {}
  });

  console.log('=== A. 初始状态 / 控制台 ===');
  // 先切回层级，避免上次测试停在 reports 导致误判
  await evalMain(ws, `document.querySelector('.nav-item[data-view="hierarchy"]').click()`);
  const boot = await evalMain(ws, `({
    view: window.ModuleApp.State.state.view,
    taskCount: window.ModuleApp.State.state.tasks.length,
    rows: document.querySelectorAll('.task-row').length,
    hasTree: !!document.querySelector('.task-tree, .empty-state'),
    moreHidden: document.getElementById('moreMenu').hidden
  })`);
  console.log('  boot', boot);
  assert(boot.view === 'hierarchy' && boot.hasTree, '层级视图已渲染');
  assert(boot.moreHidden === true, '更多菜单默认隐藏');

  console.log('\n=== B. 顶栏更多菜单 ===');
  const more = await evalMain(ws, `(function(){
    document.getElementById('moreMenuBtn').click();
    const open = !document.getElementById('moreMenu').hidden;
    document.body.click();
    const closed = document.getElementById('moreMenu').hidden;
    return { open, closed };
  })()`);
  assert(more.open && more.closed, '更多菜单开/关');

  console.log('\n=== C. 视图切换 ===');
  for (const v of ['deadline', 'gantt', 'completed', 'notes', 'reports', 'hierarchy']) {
    const r = await evalMain(ws, `(function(){
      const btn = document.querySelector('.nav-item[data-view="${v}"]');
      btn.click();
      return {
        view: window.ModuleApp.State.state.view,
        active: btn.classList.contains('active'),
        containerKids: document.getElementById('viewContainer').children.length
      };
    })()`);
    assert(r.view === v && r.active, `切到 ${v}`);
  }

  console.log('\n=== D. 搜索 + jumpNext ===');
  // 造一条可搜任务
  const mark = 'SEARCH_IT_' + Date.now();
  const created = await evalMain(ws, `(async function(){
    const t = await window.api.tasks.create({ content: '${mark}', deadline: '2099-06-01', notes: 'n1' });
    await window.ModuleApp.State.patch({ tasks: await window.api.tasks.getAll() });
    // 强制刷新
    if (window.ModuleApp.State.state.view !== 'hierarchy') {
      document.querySelector('.nav-item[data-view="hierarchy"]').click();
    }
    // 直接调用 Core 路径困难，走 load+render 近似
    const tasks = await window.api.tasks.getAll();
    window.ModuleApp.State.patch({ tasks });
    document.querySelector('.nav-item[data-view="hierarchy"]').click();
    return t;
  })()`, true);

  const search = await evalMain(ws, `(async function(){
    const si = document.getElementById('searchInput');
    si.value = '${mark}';
    si.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const Sc = window.ModuleApp.SearchController;
    Sc._collectMatchIds();
    const before = Sc._matchIds.slice();
    Sc.jumpNextMatch(false);
    await new Promise(r => setTimeout(r, 200));
    const hl = !!document.querySelector('.search-highlight-row, .task-row.selected, .task-row[data-id="${created.id}"]');
    const row = document.querySelector('.task-row[data-id="${created.id}"]');
    return { matchCount: before.length, hasRow: !!row, highlighted: hl, ids: before };
  })()`, true);
  console.log('  search', search);
  assert(search.matchCount >= 1, '搜索命中 >=1');
  assert(search.hasRow, '跳转后任务行可见');

  console.log('\n=== E. 键盘选中（模拟）===');
  const kb = await evalMain(ws, `(function(){
    // 清搜索
    window.ModuleApp.SearchController.clearSearch();
    document.querySelector('.nav-item[data-view="hierarchy"]').click();
    const rows = [...document.querySelectorAll('#viewContainer .task-row[data-id]')];
    if (!rows.length) return { ok: false, reason: 'no rows' };
    window.ModuleApp.KeyboardController._selectId(rows[0].dataset.id);
    const sel1 = window.ModuleApp.State.state.selectedId;
    // ArrowDown
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const sel2 = window.ModuleApp.State.state.selectedId;
    return { ok: true, sel1, sel2, n: rows.length, changed: sel1 !== sel2 || rows.length === 1 };
  })()`);
  console.log('  kb', kb);
  assert(kb.ok && kb.sel1, '键盘选中首行');
  assert(kb.changed, 'ArrowDown 切换或单行保持');

  console.log('\n=== F. Modal.choose ===');
  const choose = await evalMain(ws, `(async function(){
    const p = window.ModuleApp.Modal.choose({
      title: '测试',
      message: '选一项',
      choices: [
        { id: 'a', label: 'A', primary: true },
        { id: 'b', label: 'B' },
        { id: 'cancel', label: '取消' }
      ]
    });
    await new Promise(r => setTimeout(r, 50));
    const open = !document.getElementById('confirmModal').hidden;
    const btns = [...document.querySelectorAll('#confirmFooter [data-choice-id]')].map(b => b.dataset.choiceId);
    document.querySelector('#confirmFooter [data-choice-id="b"]').click();
    const val = await p;
    return { open, btns, val };
  })()`, true);
  console.log('  choose', choose);
  assert(choose.open && choose.btns.join(',') === 'a,b,cancel', 'choose 三按钮');
  assert(choose.val === 'b', 'choose 返回 b');

  console.log('\n=== G. applyPeerDelta 运行时 ===');
  const delta = await evalMain(ws, `(function(){
    const before = window.ModuleApp.State.state.tasks.length;
    // 调内部函数：挂在闭包，需从源码暴露？改用直接 patch 路径不可见。
    // 用 Runtime 无法直接调 applyPeerDelta。改为模拟 onDataChange 所需：手动调 State + 检查 render。
    // 退而验证：TASK_UPDATED 广播处理路径 —— 直接改 state 后 render
    const id = window.ModuleApp.State.state.tasks[0] && window.ModuleApp.State.state.tasks[0].id;
    if (!id) return { ok: false, reason: 'empty' };
    const tasks = window.ModuleApp.State.state.tasks.map(t => t.id === id ? { ...t, content: t.content + '_D' } : t);
    window.ModuleApp.State.patch({ tasks }, 'PEER_DELTA');
    return { ok: true, before, after: window.ModuleApp.State.state.tasks.length, id };
  })()`);
  console.log('  delta', delta);
  assert(delta.ok, 'PEER_DELTA patch 不崩');

  // 等一帧看有无异常
  await new Promise(r => setTimeout(r, 300));

  console.log('\n=== H. Widget 开关 + 主题 ===');
  const widget = await evalMain(ws, `(async function(){
    const st0 = await window.api.widget.status();
    if (!st0.open) await window.api.widget.toggle();
    await new Promise(r => setTimeout(r, 800));
    const st1 = await window.api.widget.status();
    await window.api.config.update({ theme: 'light' });
    await new Promise(r => setTimeout(r, 300));
    return { open: st1.open };
  })()`, true);
  assert(widget.open, 'widget 可打开');

  // 连 widget page
  const targets2 = await httpGet('http://127.0.0.1:9222/json/list');
  const wpage = targets2.find(t => (t.title || '').includes('组件') || (t.url || '').includes('widget.html'));
  if (wpage) {
    const wws = new WebSocket(wpage.webSocketDebuggerUrl);
    await new Promise((r, j) => { wws.onopen = r; wws.onerror = j; });
    await cdp(wws, 'Runtime.enable');
    const wt = await cdp(wws, 'Runtime.evaluate', {
      expression: `({
        hasSort: !!(window.ModuleApp && window.ModuleApp.TaskSort),
        light: document.body.classList.contains('theme-light'),
        darkDefault: !document.body.classList.contains('theme-light')
      })`,
      returnByValue: true
    });
    console.log('  widget page', wt.result.value);
    assert(wt.result.value.hasSort, 'widget 有 TaskSort');
    assert(wt.result.value.light === true, 'theme=light 时 widget 有 theme-light');

    // 回归：只改 autoPlan 不应把 theme-light 打掉
    await evalMain(ws, `(async()=>{ await window.api.config.update({ autoPlan: false }); return true; })()`, true);
    await new Promise(r => setTimeout(r, 400));
    const wt2 = await cdp(wws, 'Runtime.evaluate', {
      expression: `document.body.classList.contains('theme-light')`,
      returnByValue: true
    });
    assert(wt2.result.value === true, '无关 config 补丁不破坏 widget 主题');
    wws.close();
  } else {
    console.log('  FAIL widget page 未找到');
    failed++;
  }

  // 清理测试任务
  await evalMain(ws, `(async function(){
    const all = await window.api.tasks.getAll();
    for (const t of all) {
      if ((t.content||'').includes('SEARCH_IT_') || (t.content||'').includes('ITER_TEST_') || (t.content||'').endsWith('_D')) {
        try { await window.api.tasks.delete(t.id); } catch(e) {}
      }
    }
    // 还原主题
    await window.api.config.update({ theme: 'light' });
    return true;
  })()`, true);

  await new Promise(r => setTimeout(r, 400));
  console.log('\n=== 控制台错误 ===');
  const uniq = [...new Set(consoleErrors)].filter(x => x && !String(x).includes('Content-Security-Policy'));
  console.log(uniq.length ? uniq.join('\n') : '  (无)');
  // CSP warning 忽略；其它算失败
  assert(uniq.length === 0, '无业务控制台错误');

  ws.close();
  console.log('\n' + (failed ? `FAILED: ${failed}` : 'ALL PASS'));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
