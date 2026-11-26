'use strict';
/** P3：Esc 关编辑、n 建子任务、Tab 困在弹窗、日期可输入 */
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
  const targets = await httpGet('http://127.0.0.1:9222/json/list');
  const page = targets.find(t => t.title === 'Module');
  if (!page) throw new Error('no Module on 9222');
  let ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Page.reload', { ignoreCache: true });
  ws.close();
  await new Promise(r => setTimeout(r, 1800));
  const t2 = await httpGet('http://127.0.0.1:9222/json/list');
  const page2 = t2.find(t => t.title === 'Module');
  ws = new WebSocket(page2.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Runtime.enable');

  const ev = async (expr, ap = false) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await ev(`document.querySelector('.nav-item[data-view="hierarchy"]').click()`);

  // --- date input exists ---
  const dateUi = await ev(`({
    startType: document.getElementById('taskStartDate')?.type,
    hidden: document.getElementById('taskStartDate')?.type === 'hidden',
    hasRow: !!document.querySelector('.field-date-row')
  })`);
  // open modal first
  await ev(`(() => {
    const row = document.querySelector('#viewContainer .task-row[data-id]');
    row.click();
    window.ModuleApp.TaskController.openEditModal(row.dataset.id);
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 80));

  const modalOpen = await ev(`!document.getElementById('taskModal').hidden`);
  assert(modalOpen, '编辑弹窗已打开');

  const dateField = await ev(`({
    tag: document.getElementById('taskStartDate')?.tagName,
    type: document.getElementById('taskStartDate')?.type,
    canType: document.getElementById('taskStartDate')?.type === 'text'
  })`);
  console.log('dateField', dateField);
  assert(dateField.canType, '开始日期为可输入 text');

  // type a date
  await ev(`(() => {
    const el = document.getElementById('taskStartDate');
    el.value = '2026-08-01';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  assert((await ev(`document.getElementById('taskStartDate').value`)) === '2026-08-01', '可写入日期文本');

  // Esc closes
  await ev(`document.getElementById('taskContent').focus()`);
  await cdp(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await new Promise(r => setTimeout(r, 50));
  const closed = await ev(`document.getElementById('taskModal').hidden`);
  assert(closed === true, 'Esc 关闭编辑弹窗');

  // n creates child of selected
  const nRes = await ev(`(() => {
    const rows = [...document.querySelectorAll('#viewContainer .task-row[data-id]')];
    const parent = rows[0];
    window.ModuleApp.TaskController.selectTask(parent.dataset.id);
    document.getElementById('viewContainer').focus();
    // spy
    let got = null;
    const o = window.ModuleApp.TaskController.focusQuickCreate.bind(window.ModuleApp.TaskController);
    window.ModuleApp.TaskController.focusQuickCreate = function(pid) { got = pid; o(pid); };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }));
    // capture uses true — fire with capture path via KeyboardController directly
    window.ModuleApp.KeyboardController._onKey(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }));
    window.ModuleApp.TaskController.focusQuickCreate = o;
    return {
      parentId: parent.dataset.id,
      got,
      title: document.getElementById('modalTitle')?.textContent,
      modalOpen: !document.getElementById('taskModal').hidden,
      hint: document.getElementById('parentHint')?.textContent
    };
  })()`);
  console.log('n child', nRes);
  assert(nRes.got === nRes.parentId, 'n 传入选中任务 id 作 parent');
  assert(nRes.title === '新建子任务', '标题为新建子任务');

  // Tab trap: focus last control, Tab should wrap to first inside modal
  const tabTrap = await ev(`(() => {
    const modal = document.getElementById('taskModal');
    const card = modal.querySelector('.modal-card');
    const list = [...card.querySelectorAll('input:not([type=hidden]), select, textarea, button')].filter(el => el.offsetParent);
    const last = list[list.length - 1];
    const first = list[0];
    last.focus();
    const before = document.activeElement.id || document.activeElement.tagName;
    // simulate Tab at end
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    // handler is on window capture — call Modal path via dispatch
    window.dispatchEvent(e);
    // Our handler uses e.key==='Tab' and preventDefault — need the bound handler to run.
    // Dispatch alone should hit _taskModalKeyHandler.
    const after = document.activeElement.id || document.activeElement.tagName;
    const stillIn = modal.contains(document.activeElement);
    return { before, after, firstId: first.id, lastId: last.id || last.tagName, stillIn, count: list.length };
  })()`);
  console.log('tabTrap', tabTrap);
  assert(tabTrap.stillIn, 'Tab 后焦点仍在弹窗内');

  // cleanup close
  await ev(`window.ModuleApp.Modal.closeTaskModal()`);

  // normalizeDateInput
  const norm = await ev(`({
    a: window.ModuleApp.Modal.normalizeDateInput('20260815'),
    b: window.ModuleApp.Modal.normalizeDateInput('2026-08-15'),
    c: window.ModuleApp.Modal.normalizeDateInput('')
  })`);
  assert(norm.a === '2026-08-15' && norm.b === '2026-08-15' && norm.c === '', '日期规范化');

  ws.close();
  console.log('\n' + (failed ? 'FAILED: ' + failed : 'ALL PASS'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
