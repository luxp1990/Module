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

async function ev(ws, expression, awaitPromise = false) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
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
  if (!page) throw new Error('no Module');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Runtime.enable');

  console.log('=== create 返回值 computed 字段 ===');
  const created = await ev(ws, `(async () => {
    const t = await window.api.tasks.create({
      content: 'PROBE_COMPUTED_' + Date.now(),
      deadline: '2099-01-01',
      notes: null
    });
    return {
      id: t.id,
      hasLevel: t.level != null,
      hasDays: t.daysLeft != null,
      hasUrgency: t.urgency != null,
      keys: Object.keys(t).sort()
    };
  })()`, true);
  console.log(created);
  assert(created.hasLevel, 'create 返回含 level（Delta payload 需要）');
  assert(created.hasDays, 'create 返回含 daysLeft');
  assert(created.hasUrgency, 'create 返回含 urgency');

  console.log('\n=== getAll 对照 ===');
  const allOne = await ev(ws, `(async () => {
    const t = (await window.api.tasks.getAll()).find(x => x.id === '${created.id}');
    return t ? { hasLevel: t.level != null, hasDays: t.daysLeft != null, urgency: t.urgency } : null;
  })()`, true);
  console.log(allOne);
  assert(allOne && allOne.hasLevel, 'getAll 有 computed');

  console.log('\n=== confirm 在 choose 后 ===');
  const conf = await ev(ws, `(async () => {
    const p = window.ModuleApp.Modal.confirm({ title: 't', message: 'm' });
    await new Promise(r => setTimeout(r, 40));
    const ok = document.getElementById('confirmOk');
    const info = { hasOk: !!ok, text: ok && ok.textContent };
    document.getElementById('confirmClose').click();
    const v = await p;
    return { ...info, v };
  })()`, true);
  console.log(conf);
  assert(conf.hasOk && conf.text === '确定' && conf.v === false, 'choose 后 confirm 恢复单按钮');

  console.log('\n=== 层级/截止渲染 ===');
  const views = await ev(ws, `(() => {
    const out = {};
    for (const v of ['hierarchy', 'deadline']) {
      document.querySelector('.nav-item[data-view="' + v + '"]').click();
      out[v] = {
        rows: document.querySelectorAll('.task-row').length,
        ok: !!(document.querySelector('.task-tree') || document.querySelector('.empty-state'))
      };
    }
    return out;
  })()`);
  console.log(views);
  assert(views.hierarchy.ok, 'hierarchy 渲染');
  assert(views.deadline.ok, 'deadline 渲染');

  // cleanup
  await ev(ws, `(async () => {
    const all = await window.api.tasks.getAll();
    for (const t of all) {
      if ((t.content || '').includes('PROBE_COMPUTED_') || (t.content || '').includes('SEARCH_IT_') || (t.content || '').includes('ITER_TEST_')) {
        try { await window.api.tasks.delete(t.id); } catch (e) {}
      }
    }
    return true;
  })()`, true);

  ws.close();
  console.log('\n' + (failed ? 'FAILED: ' + failed : 'ALL PASS'));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
