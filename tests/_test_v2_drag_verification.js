const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const exePath = path.resolve(__dirname, '../src-tauri/target/release/module.exe');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const callbacks = new Map();

    ws.onopen = () => resolve({ ws, send });
    ws.onerror = reject;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && callbacks.has(msg.id)) {
        const { resolve, reject } = callbacks.get(msg.id);
        callbacks.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };

    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const msgId = id++;
        callbacks.set(msgId, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }
  });
}

async function verify() {
  console.log('=== Step 1: Building Release Module v2.1.4 ===');
  execSync('cargo build --release', { cwd: path.resolve(__dirname, '../src-tauri'), stdio: 'inherit' });

  console.log('\n=== Step 2: Launching Module v2.1.4 with Remote Debugging ===');
  try { execSync('taskkill /F /IM module.exe', { stdio: 'ignore' }); } catch (_) {}
  const appProc = spawn(exePath, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' },
    detached: false, stdio: 'ignore'
  });

  let targets = null;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 600));
    try {
      targets = await getJson('http://127.0.0.1:9222/json');
      if (targets && targets.length > 0) break;
    } catch (_) {}
  }
  if (!targets) throw new Error('Could not connect to CDP on 9222');

  const mainTarget = targets.find(t => t.url.endsWith('/') || t.url.includes('index.html') || t.title === 'Module');
  const { send, ws } = await connectCdp(mainTarget.webSocketDebuggerUrl);

  await send('Runtime.enable');
  let errors = [];
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map(a => a.value || a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(JSON.stringify(msg.params.exceptionDetails));
      }
    } catch (_) {}
  });

  console.log('\n=== Step 3: Switch to Hierarchy View and Verify DnD ===');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const nav = document.querySelector('.nav-item[data-view="hierarchy"]');
      if (nav) nav.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 600));

  // Test 1: Programmatic DnD of a task to become child
  const test1 = await send('Runtime.evaluate', {
    expression: `(async () => {
      const rows = document.querySelectorAll('.task-row[draggable="true"]');
      if (rows.length < 2) return { ok: false, error: 'Need at least 2 rows' };

      const r0 = rows[0]; // target parent
      const r1 = rows[1]; // task to drag into child
      const targetId = r0.dataset.id;
      const dragId = r1.dataset.id;

      let toastMsg = null;
      const origToast = window.ModuleApp.Toast.show;
      window.ModuleApp.Toast.show = (msg, type) => {
        toastMsg = { msg, type };
        origToast(msg, type);
      };

      const dt = new DataTransfer();
      r1.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

      const rect = r0.getBoundingClientRect();
      r0.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height * 0.5,
        dataTransfer: dt
      }));

      r0.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height * 0.5,
        dataTransfer: dt
      }));

      await new Promise(r => setTimeout(r, 600));
      const updated = window.ModuleApp.State.state.tasks.find(t => t.id === dragId);
      return {
        ok: updated && updated.parentId === targetId,
        dragId,
        targetId,
        updatedParentId: updated?.parentId,
        toastMsg
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('   Test 1 (Drag to Child):', test1.result.value);

  // Test 2: Drag task to root level (promote out of parent)
  const test2 = await send('Runtime.evaluate', {
    expression: `(async () => {
      const childRows = document.querySelectorAll('.task-row[data-level="1"], .task-row[data-level="2"]');
      if (childRows.length === 0) return { ok: false, error: 'No child row found' };
      const childRow = childRows[0];
      const rootRow = document.querySelectorAll('.task-row[data-level="0"]')[0];
      const childId = childRow.dataset.id;

      let toastMsg = null;
      const origToast = window.ModuleApp.Toast.show;
      window.ModuleApp.Toast.show = (msg, type) => { toastMsg = { msg, type }; origToast(msg, type); };

      const dt = new DataTransfer();
      childRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

      // Hover on top 10% of rootRow -> ratio < 0.25 -> previewParentId = rootRow.parentId = null
      const rect = rootRow.getBoundingClientRect();
      rootRow.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height * 0.1,
        dataTransfer: dt
      }));

      rootRow.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height * 0.1,
        dataTransfer: dt
      }));

      await new Promise(r => setTimeout(r, 600));
      const updated = window.ModuleApp.State.state.tasks.find(t => t.id === childId);
      return {
        ok: updated && updated.parentId === null,
        childId,
        updatedParentId: updated?.parentId,
        toastMsg
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('   Test 2 (Drag to Root):', test2.result.value);

  // Test 3: Circular dependency prevention
  const test3 = await send('Runtime.evaluate', {
    expression: `(async () => {
      // Find a parent task that has children
      const state = window.ModuleApp.State.state;
      const parentTask = state.tasks.find(t => state.tasks.some(c => c.parentId === t.id));
      const childTask = state.tasks.find(c => c.parentId === parentTask.id);

      const parentRow = document.querySelector('.task-row[data-id="' + parentTask.id + '"]');
      const childRow = document.querySelector('.task-row[data-id="' + childTask.id + '"]');

      let toastMsg = null;
      const origToast = window.ModuleApp.Toast.show;
      window.ModuleApp.Toast.show = (msg, type) => { toastMsg = { msg, type }; origToast(msg, type); };

      const dt = new DataTransfer();
      parentRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));

      const rect = childRow.getBoundingClientRect();
      childRow.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height * 0.5,
        dataTransfer: dt
      }));

      const isInvalidOver = window.ModuleApp.DragController._dragInvalid;

      childRow.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height * 0.5,
        dataTransfer: dt
      }));

      await new Promise(r => setTimeout(r, 300));
      const parentAfter = window.ModuleApp.State.state.tasks.find(t => t.id === parentTask.id);
      return {
        ok: parentAfter.parentId !== childTask.id, // Must NOT become child of its own child
        isInvalidOver,
        toastMsg
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  console.log('   Test 3 (Circular Check):', test3.result.value);

  ws.close();
  try { execSync('taskkill /F /IM module.exe', { stdio: 'ignore' }); } catch (_) {}

  console.log('\n=== Step 4: Verification Summary ===');
  console.log('Test 1 Passed:', test1.result.value.ok);
  console.log('Test 2 Passed:', test2.result.value.ok);
  console.log('Test 3 Passed:', test3.result.value.ok);
  console.log('Errors caught:', errors.length);

  if (!test1.result.value.ok || !test2.result.value.ok || !test3.result.value.ok || errors.length > 0) {
    throw new Error('Verification failed!');
  }
  console.log('\nALL DRAG & DROP TESTS PASSED!');
}

verify().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});
