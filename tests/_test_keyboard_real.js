'use strict';
/**
 * 真实焦点路径验证快捷键（Input.dispatchKeyEvent）
 * 前置：Electron --remote-debugging-port=9222，且已加载最新 renderer（需刷新主窗）
 */
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

async function key(ws, key, code) {
  const defs = {
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
    Slash: { key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' },
    KeyN: { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, text: 'n' },
  };
  const d = defs[key];
  await cdp(ws, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: d.key,
    code: d.code,
    windowsVirtualKeyCode: d.windowsVirtualKeyCode,
    nativeVirtualKeyCode: d.windowsVirtualKeyCode,
    text: d.text,
    unmodifiedText: d.text
  });
  await cdp(ws, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: d.key,
    code: d.code,
    windowsVirtualKeyCode: d.windowsVirtualKeyCode,
    nativeVirtualKeyCode: d.windowsVirtualKeyCode
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
  if (!page) throw new Error('no Module — 请先启动带 9222 的 Electron 并刷新主窗');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Page.enable');

  // 硬刷新以加载最新 JS
  await cdp(ws, 'Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 1500));
  // reconnect after reload
  ws.close();
  const targets2 = await httpGet('http://127.0.0.1:9222/json/list');
  const page2 = targets2.find(t => t.title === 'Module');
  const ws2 = new WebSocket(page2.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws2.onopen = r; ws2.onerror = j; });
  await cdp(ws2, 'Runtime.enable');
  await cdp(ws2, 'Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});

  const ev = async (expr, ap = false) => {
    const r = await cdp(ws2, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: ap });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  // 准备：层级 + 关弹窗
  await ev(`(() => {
    document.querySelector('.nav-item[data-view="hierarchy"]').click();
    document.querySelectorAll('.modal').forEach(m => m.hidden = true);
    const m = document.getElementById('moreMenu'); if (m) m.hidden = true;
    return true;
  })()`);

  // 用 JS 点选第一行（走 selectTask）
  const clicked = await ev(`(() => {
    const row = document.querySelector('#viewContainer .task-row[data-id]');
    if (!row) return null;
    row.click();
    return {
      id: row.dataset.id,
      active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      selectedId: window.ModuleApp.State.state.selectedId
    };
  })()`);
  console.log('after click', clicked);
  assert(clicked && clicked.active === 'viewContainer', '点选后焦点在 viewContainer（不是 quickInput）');
  assert(clicked && clicked.selectedId === clicked.id, '点选后 selectedId 正确');

  const id0 = clicked.id;

  // ↑↓
  await key(ws2, 'ArrowDown');
  const afterDown = await ev(`({
    selectedId: window.ModuleApp.State.state.selectedId,
    active: document.activeElement && document.activeElement.id
  })`);
  console.log('ArrowDown', afterDown);
  assert(afterDown.selectedId && afterDown.selectedId !== id0, 'ArrowDown 换选中');

  await key(ws2, 'ArrowUp');
  const afterUp = await ev(`window.ModuleApp.State.state.selectedId`);
  assert(afterUp === id0, 'ArrowUp 回到首行');

  // Enter 编辑
  let editOpen = false;
  await ev(`(() => {
    window.__testEdit = false;
    const o = window.ModuleApp.TaskController.openEditModal.bind(window.ModuleApp.TaskController);
    window.ModuleApp.TaskController.openEditModal = function(id) {
      window.__testEdit = id;
      // 不真正打开，避免挡后续键
    };
    window.__restoreEdit = () => { window.ModuleApp.TaskController.openEditModal = o; };
    return true;
  })()`);
  await key(ws2, 'Enter');
  editOpen = await ev(`window.__testEdit`);
  await ev(`window.__restoreEdit()`);
  console.log('Enter', editOpen);
  assert(editOpen === id0 || !!editOpen, 'Enter 触发编辑');

  // Space 完成（mock）
  await ev(`(() => {
    window.__testComplete = null;
    const o = window.ModuleApp.TaskController.handleComplete.bind(window.ModuleApp.TaskController);
    window.ModuleApp.TaskController.handleComplete = function(id) {
      window.__testComplete = id;
      return Promise.resolve();
    };
    window.__restoreComplete = () => { window.ModuleApp.TaskController.handleComplete = o; };
    // 确保仍选中
    window.ModuleApp.TaskController.selectTask('${id0}');
    return true;
  })()`);
  await key(ws2, 'Space');
  const completed = await ev(`window.__testComplete`);
  await ev(`window.__restoreComplete()`);
  console.log('Space', completed);
  assert(completed === id0, 'Space 触发完成');

  // /
  await ev(`document.getElementById('viewContainer').focus()`);
  await key(ws2, 'Slash');
  const slash = await ev(`document.activeElement && document.activeElement.id`);
  console.log('Slash', slash);
  assert(slash === 'searchInput', '/ 聚焦搜索');

  // n 新建（mock modal）
  await ev(`(() => {
    document.getElementById('searchInput').blur();
    document.getElementById('viewContainer').focus();
    window.__testCreate = false;
    const o = window.ModuleApp.TaskController.focusQuickCreate.bind(window.ModuleApp.TaskController);
    window.ModuleApp.TaskController.focusQuickCreate = function(p) { window.__testCreate = true; };
    window.__restoreCreate = () => { window.ModuleApp.TaskController.focusQuickCreate = o; };
    return true;
  })()`);
  await key(ws2, 'KeyN');
  const created = await ev(`window.__testCreate`);
  await ev(`window.__restoreCreate()`);
  console.log('n', created);
  assert(created === true, 'n 触发新建');

  // 底栏聚焦时 ↑↓ 仍可用
  await ev(`(() => {
    const rows = [...document.querySelectorAll('#viewContainer .task-row[data-id]')];
    window.ModuleApp.TaskController.selectTask(rows[0].dataset.id);
    document.getElementById('quickInput').focus();
    window.__idBefore = window.ModuleApp.State.state.selectedId;
    return document.activeElement.id;
  })()`);
  await key(ws2, 'ArrowDown');
  const fromQi = await ev(`({
    active: document.activeElement.id,
    selectedId: window.ModuleApp.State.state.selectedId,
    before: window.__idBefore,
    changed: window.ModuleApp.State.state.selectedId !== window.__idBefore
  })`);
  console.log('ArrowDown from quickInput', fromQi);
  assert(fromQi.changed, '底栏聚焦时 ArrowDown 仍换选中');

  ws2.close();
  console.log('\n' + (failed ? 'FAILED: ' + failed : 'ALL PASS'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
