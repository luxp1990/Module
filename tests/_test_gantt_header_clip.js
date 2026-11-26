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
  const page = targets.find(t => t.title === 'Module');
  if (!page) throw new Error('no Module');
  let ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp(ws, 'Page.reload', { ignoreCache: true });
  ws.close();
  await new Promise(r => setTimeout(r, 1600));
  const t2 = await httpGet('http://127.0.0.1:9222/json/list');
  const page2 = t2.find(t => t.title === 'Module');
  ws = new WebSocket(page2.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  const ev = async (expr) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  await ev(`document.querySelector('.nav-item[data-view="gantt"]').click()`);
  await new Promise(r => setTimeout(r, 500));

  const css = await ev(`(() => {
    const h = document.querySelector('.gantt-header');
    const th = document.querySelector('.gantt-track-header');
    const body = document.querySelector('.gantt-body');
    const track = document.querySelector('.gantt-track');
    const wrap = document.querySelector('.gantt-wrap');
    if (wrap) wrap.scrollTop = 90;
    const hs = h && getComputedStyle(h);
    const ths = th && getComputedStyle(th);
    const bs = body && getComputedStyle(body);
    const ts = track && getComputedStyle(track);
    return {
      headerBg: hs && hs.backgroundColor,
      headerZ: hs && hs.zIndex,
      trackHeaderBg: ths && ths.backgroundColor,
      bodyTransform: bs && bs.transform,
      trackOverflow: ts && ts.overflow,
      scrollTop: wrap && wrap.scrollTop,
      hasHeader: !!h,
      hasBars: document.querySelectorAll('.gantt-bar').length
    };
  })()`);

  console.log(css);
  const opaque = css.headerBg && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(css.headerBg);
  const ok = css.headerZ === '40' && css.bodyTransform === 'none' && css.trackOverflow === 'hidden' && opaque;
  console.log(ok ? 'PASS' : 'FAIL');
  ws.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
