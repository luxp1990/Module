'use strict';
/** 实测红框快捷键：↑↓ Enter Space / n */
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
  const targets = await httpGet('http://127.0.0.1:9222/json/list');
  const page = targets.find(t => t.title === 'Module');
  if (!page) throw new Error('Module not running on 9222');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Runtime.enable');

  const report = await cdp(ws, 'Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const out = { steps: [] };
      const log = (k, v) => out.steps.push({ k, v });

      // 切到层级
      document.querySelector('.nav-item[data-view="hierarchy"]').click();
      await new Promise(r => setTimeout(r, 50));

      // 关掉可能开着的弹层
      document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });
      const more = document.getElementById('moreMenu');
      if (more) more.hidden = true;

      log('hasKb', !!window.ModuleApp.KeyboardController);
      log('view', window.ModuleApp.State.state.view);
      log('rows', document.querySelectorAll('#viewContainer .task-row[data-id]').length);
      log('activeBefore', document.activeElement && (document.activeElement.id || document.activeElement.tagName));

      function fire(key, target) {
        const el = target || document.body;
        el.focus?.();
        const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, code: key === ' ' ? 'Space' : undefined });
        el.dispatchEvent(ev);
        // also dispatch on window (listener is on window)
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      }

      // A: 焦点在 body 时测 ↑↓
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      document.body.focus();
      window.ModuleApp.State.patch({ selectedId: null, multiSelect: new Set() });
      document.querySelectorAll('.task-row.selected').forEach(el => el.classList.remove('selected'));
      fire('ArrowDown', document.body);
      await new Promise(r => setTimeout(r, 30));
      log('afterArrowDown_body', {
        selectedId: window.ModuleApp.State.state.selectedId,
        active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
        hasSelectedClass: !!document.querySelector('.task-row.selected')
      });

      // B: 焦点在 quickInput 时测 ↑↓ 与 /
      const qi = document.getElementById('quickInput');
      qi.focus();
      const selBeforeQi = window.ModuleApp.State.state.selectedId;
      fire('ArrowDown', qi);
      log('afterArrowDown_quickInput', {
        selectedId: window.ModuleApp.State.state.selectedId,
        changed: window.ModuleApp.State.state.selectedId !== selBeforeQi,
        active: document.activeElement.id
      });
      fire('/', qi);
      log('afterSlash_quickInput', { active: document.activeElement.id });

      // C: 焦点在 body 时测 /
      document.getElementById('searchInput').blur();
      qi.blur();
      document.body.focus();
      fire('/', document.body);
      await new Promise(r => setTimeout(r, 20));
      log('afterSlash_body', { active: document.activeElement.id });

      // D: body 焦点测 n
      document.getElementById('searchInput').blur();
      document.body.focus();
      // close any modal first
      document.querySelectorAll('.modal').forEach(m => { m.hidden = true; });
      fire('n', document.body);
      await new Promise(r => setTimeout(r, 40));
      const taskModal = document.getElementById('taskModal');
      log('afterN_body', { modalOpen: taskModal && !taskModal.hidden, title: document.getElementById('modalTitle')?.textContent });
      if (taskModal) taskModal.hidden = true;
      window.ModuleApp.State.patch({ modalTask: null });

      // E: 先选中再 Enter / Space（不真完成——拦截？只检查是否调用）
      document.body.focus();
      const rows = [...document.querySelectorAll('#viewContainer .task-row[data-id]')];
      if (rows.length) {
        window.ModuleApp.KeyboardController._selectId(rows[0].dataset.id);
        const id = window.ModuleApp.State.state.selectedId;
        let editCalled = false;
        const orig = window.ModuleApp.TaskController.openEditModal;
        window.ModuleApp.TaskController.openEditModal = function(x) { editCalled = true; };
        fire('Enter', document.body);
        window.ModuleApp.TaskController.openEditModal = orig;
        log('afterEnter_body', { id, editCalled });

        let completeCalled = false;
        const origC = window.ModuleApp.TaskController.handleComplete;
        window.ModuleApp.TaskController.handleComplete = function(x) { completeCalled = true; return Promise.resolve(); };
        fire(' ', document.body);
        window.ModuleApp.TaskController.handleComplete = origC;
        log('afterSpace_body', { id, completeCalled });
      }

      // F: 焦点在 searchInput 时 ArrowDown
      document.getElementById('searchInput').focus();
      const before = window.ModuleApp.State.state.selectedId;
      fire('ArrowDown', document.getElementById('searchInput'));
      log('afterArrowDown_search', {
        changed: window.ModuleApp.State.state.selectedId !== before,
        active: document.activeElement.id
      });

      return out;
    })()`
  });

  console.log(JSON.stringify(report.result.value, null, 2));
  ws.close();
})().catch(e => { console.error(e); process.exit(1); });
