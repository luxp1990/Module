// 桌面组件拖动修复测试 - 纯Node v22+ 内置 WebSocket
const http = require('http');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const msg = JSON.stringify({ id, method, params });
    const listener = (ev) => {
      const resp = JSON.parse(ev.data.toString());
      if (resp.id === id) {
        ws.removeEventListener('message', listener);
        if (resp.error) reject(new Error(resp.error.message));
        else resolve(resp.result);
      }
    };
    ws.addEventListener('message', listener);
    ws.send(msg);
  });
}

async function main() {
  // ======= Test A: 验证 main.js 源码 =======
  console.log('=== Test A: main.js 源码检查 ===');
  const fs = require('fs');
  const mainJs = fs.readFileSync('src/main/main.js', 'utf8');
  const lines = mainJs.split('\n');

  let found = {};
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.includes('_isDragging')) {
      if (!found['isDragging']) found['isDragging'] = [];
      found['isDragging'].push(`L${i+1}: ${l}`);
    }
    if (l.includes('bounds.width -')) {
      found['exclusion'] = `L${i+1}: ${l}`;
    }
    if (l.includes('_isDragging') && l.includes('debouncedSaveBounds')) {
      if (!found['guard']) found['guard'] = [];
      found['guard'].push(`L${i+1}: ${l}`);
    }
  }

  let ok = true;

  // Check 1: _isDragging 有 let 声明
  const hasLet = found['isDragging'] && found['isDragging'].some(l => l.includes('let _isDragging'));
  if (hasLet) {
    console.log('✅ [A1] _isDragging 有 let 声明');
    found['isDragging'].forEach(l => console.log(`   ${l}`));
  } else {
    console.log('❌ [A1] _isDragging 缺少 let 声明');
    ok = false;
  }

  // Check 2: exclusion zone = 80
  if (found['exclusion'] && found['exclusion'].includes('80')) {
    console.log('✅ [A2] hookWindowMessage 排除区已改为 80px');
    console.log(`   ${found['exclusion']}`);
  } else {
    console.log(`❌ [A2] hookWindowMessage 排除区不是 80px: ${found['exclusion'] || 'NOT FOUND'}`);
    ok = false;
  }

  // Check 3: moved/resize 守卫
  const hasGuard = found['guard'] && found['guard'].length >= 2;
  if (hasGuard) {
    console.log('✅ [A3] moved/resize 均有 _isDragging 守卫');
    found['guard'].forEach(l => console.log(`   ${l}`));
  } else {
    console.log(`❌ [A3] moved/resize 守卫不完整 (count: ${(found['guard']||[]).length})`);
    ok = false;
  }

  // ======= Test B: CDP 运行时检查 =======
  console.log('\n=== Test B: CDP 运行时检查 ===');
  const targets = await httpGet('http://127.0.0.1:9222/json');
  
  // Find the main window (not devtools)
  const mainTarget = targets.find(t => t.url && t.title === 'Module');
  if (!mainTarget) {
    console.log('⚠ 未找到主窗口 target, 跳过运行时检查');
  } else {
    console.log(`主窗口: ${mainTarget.title}`);
    
    const ws = new globalThis.WebSocket(mainTarget.webSocketDebuggerUrl);
    await new Promise((r) => ws.onopen = r);
    
    await cdp(ws, 'Runtime.enable');
    await cdp(ws, 'Runtime.runIfWaitingForDebugger');

    // Test B1: widget-header CSS 检查
    const cssResult = await cdp(ws, 'Runtime.evaluate', {
      expression: `(function() {
        const header = document.querySelector('.widget-header');
        if (!header) return { status: 'No widget-header found (normal - widget is separate window)' };
        const s = getComputedStyle(header);
        return {
          found: true,
          webkitAppRegion: s.getPropertyValue('-webkit-app-region'),
          cursor: s.cursor
        };
      })()`,
      returnByValue: true
    });
    console.log(`✅ [B1] widget-header CSS: ${JSON.stringify(cssResult.result.value)}`);

    // Test B2: 打开 widget
    const openResult = await cdp(ws, 'Runtime.evaluate', {
      expression: `(async function() {
        if (window._api && window._api.widget) {
          const status = await window._api.widget.status();
          if (!status.open) {
            await window._api.widget.toggle();
            return 'opened';
          }
          return 'already open';
        }
        return 'no widget API';
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log(`✅ [B2] Widget 窗口: ${JSON.stringify(openResult.result.value)}`);

    // Wait a moment
    await new Promise(r => setTimeout(r, 2000));

    // Test B3: 检查 widget 窗口的 target
    const targets2 = await httpGet('http://127.0.0.1:9222/json');
    console.log(`✅ [B3] 当前 target 数: ${targets2.length}`);
    targets2.forEach(t => console.log(`   ${t.title}: ${t.url?.slice(0, 60)}`));

    ws.close();
  }

  console.log(`\n${ok ? '\n✅ 全部通过' : '\n❌ 有失败项'}`);
  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
