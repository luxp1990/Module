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
  const targets = await httpGet('http://127.0.0.1:9222/json/list');
  const main = targets.find(t => t.title === 'Module');
  const widget = targets.find(t => (t.url || '').includes('widget.html') || (t.title || '').includes('组件'));

  // --- Main: more menu color ---
  if (main) {
    const ws = new WebSocket(main.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    await cdp(ws, 'Runtime.enable');
    const m = await cdp(ws, 'Runtime.evaluate', {
      expression: `(async () => {
        await window.api.config.update({ theme: 'light' });
        document.body.classList.remove('theme-dark');
        const btn = document.getElementById('moreMenuBtn');
        const menu = document.getElementById('moreMenu');
        menu.hidden = false;
        const item = menu.querySelector('.toolbar-more-item');
        const cs = getComputedStyle(item);
        menu.hidden = true;
        return {
          bodyDark: document.body.classList.contains('theme-dark'),
          itemColor: cs.color,
          itemBg: cs.backgroundColor,
          menuBg: getComputedStyle(menu).backgroundColor
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('MAIN more-menu', m.result.value);
    ws.close();
  } else console.log('MAIN missing');

  // --- Widget: force light + measure hard-coded dark surfaces ---
  if (!widget) {
    // open widget from main
    const ws = new WebSocket(main.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    await cdp(ws, 'Runtime.enable');
    await cdp(ws, 'Runtime.evaluate', {
      expression: `(async()=>{ const s=await window.api.widget.status(); if(!s.open) await window.api.widget.toggle(); await window.api.config.update({theme:'light'}); return true; })()`,
      returnByValue: true, awaitPromise: true
    });
    ws.close();
    await new Promise(r => setTimeout(r, 1000));
  }

  const targets2 = await httpGet('http://127.0.0.1:9222/json/list');
  const wpage = targets2.find(t => (t.url || '').includes('widget.html') || (t.title || '').includes('组件'));
  if (!wpage) { console.log('WIDGET missing'); process.exit(1); }

  const wws = new WebSocket(wpage.webSocketDebuggerUrl);
  await new Promise((r, j) => { wws.onopen = r; wws.onerror = j; });
  await cdp(wws, 'Runtime.enable');
  const report = await cdp(wws, 'Runtime.evaluate', {
    expression: `(async () => {
      // ensure light
      document.body.classList.add('theme-light');
      // open first task edit panel if any
      const item = document.querySelector('.task-item');
      if (item) {
        item.click();
        await new Promise(r => setTimeout(r, 100));
      }
      const actions = document.querySelector('.task-actions.show, .task-actions');
      // force show if exists in DOM
      const anyActions = document.querySelector('.task-actions');
      if (anyActions) anyActions.classList.add('show');

      function bg(sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color, border: cs.borderColor };
      }

      const text = document.querySelector('.task-text');
      const note = document.querySelector('.note-text');
      return {
        themeLight: document.body.classList.contains('theme-light'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        taskActions: bg('.task-actions'),
        taskActionsInput: (() => {
          const el = document.querySelector('.task-actions input, .task-actions textarea');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, color: cs.color };
        })(),
        taskText: text ? getComputedStyle(text).color : null,
        taskItem: bg('.task-item'),
        noteText: note ? getComputedStyle(note).color : null,
        noteItem: bg('.note-item'),
        quickAdd: bg('.quick-add'),
        btnCancel: (() => {
          const el = document.querySelector('.task-actions .btn-cancel');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, color: cs.color };
        })(),
        // luminance helper: parse rgb
        issues: []
      };
    })()`,
    returnByValue: true,
    awaitPromise: true
  });
  const v = report.result.value;
  console.log(JSON.stringify(v, null, 2));

  // classify dark leftovers
  function lum(rgb) {
    if (!rgb || typeof rgb !== 'string') return null;
    const m = rgb.match(/\d+/g);
    if (!m || m.length < 3) return null;
    const [r, g, b] = m.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const problems = [];
  const taLum = lum(v.taskActions && v.taskActions.bg);
  if (taLum != null && taLum < 100) problems.push('task-actions 背景仍深: ' + v.taskActions.bg + ' L=' + taLum.toFixed(1));
  const inLum = lum(v.taskActionsInput && v.taskActionsInput.bg);
  // rgba(255,255,255,0.06) parses as high RGB but alpha low — also check color contrast
  if (v.taskActionsInput) {
    const cLum = lum(v.taskActionsInput.color);
    if (cLum != null && cLum > 180 && taLum != null && taLum > 180) {
      /* light text on light panel — bad */
      problems.push('task-actions input 浅字浅底: color=' + v.taskActionsInput.color);
    }
    // dark panel leftover: if actions bg dark
  }
  const ttLum = lum(v.taskText);
  if (ttLum != null && ttLum > 180) problems.push('task-text 仍浅色字: ' + v.taskText);
  const btnLum = lum(v.btnCancel && v.btnCancel.bg);
  if (v.taskActions && taLum != null && taLum > 180) {
    // light panel — cancel should not be near-invisible white-on-white; ok if gray
  }

  console.log('\nPROBLEMS:');
  problems.forEach(p => console.log(' -', p));
  if (!problems.length) console.log(' (none)');
  // hard assert for the screenshot bug
  if (taLum != null && taLum < 100) process.exit(1);
  if (ttLum != null && ttLum > 180) process.exit(1);
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
