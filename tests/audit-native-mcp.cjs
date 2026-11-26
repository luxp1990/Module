'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const exe = process.argv[2] || path.resolve(__dirname, '../src-tauri/target/release/module.exe');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'module-native-audit-'));
  const dataFile = path.join(temp, 'tasks.json');
  const pending = new Map();
  const child = spawn(exe, ['--mcp'], {
    env: { ...process.env, MODULE_DATA_PATH: dataFile },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let nextId = 0, buffer = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  function failAll(error) {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  }
  child.on('error', failAll);
  child.on('exit', code => failAll(Error(`MCP exited (${code}): ${stderr}`)));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (e) { failAll(e); continue; }
      const call = pending.get(message.id);
      if (!call) continue;
      pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(Error(JSON.stringify(message.error)));
      else call.resolve(message.result);
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function tool(name, args = {}, expectError = false) {
    const result = await send('tools/call', { name, arguments: args });
    assert.equal(!!result.isError, expectError, JSON.stringify(result));
    return expectError ? result : JSON.parse(result.content[0].text);
  }
  try {
    const init = await send('initialize');
    assert.equal(init.serverInfo.version, require('../package.json').version);
    assert.equal((await send('tools/list')).tools.length, 11);
    assert.equal((await tool('get_tasks')).tasks.length, 0, 'must use isolated data');
    const root = await tool('create_task', { content: '隔离测试：父任务', deadline: '2026-11-30' });
    const childTask = await tool('create_task', { content: '隔离测试：子任务', parentId: root.id });
    await tool('update_task', { id: root.id, updates: { parentId: childTask.id } }, true);
    assert.equal((await tool('get_tasks')).tasks.length, 2);
    const external = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    external.tasks.push({ id: 'external', content: '另一个进程的任务' });
    fs.writeFileSync(dataFile, JSON.stringify(external));
    assert.equal((await tool('get_tasks')).tasks.length, 3, 'reload external writes between MCP calls');
    const tree = await tool('get_task_tree');
    assert.equal(tree.tree.length, 2);
    const completed = await tool('complete_task', { id: root.id });
    assert.equal(completed.affectedDescendants, 1);
    await tool('delete_task', { id: root.id });
    assert.equal((await tool('get_tasks')).tasks[0].id, 'external');
    await tool('delete_task', { id: 'external' });
    assert.equal((await tool('get_tasks')).tasks.length, 0);
    const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(disk.tasks.length, 0);
    assert.equal(disk.config.theme, 'light');
    fs.writeFileSync(dataFile, '{broken-json');
    const damaged = spawnSync(exe, ['--mcp'], {
      env: { ...process.env, MODULE_DATA_PATH: dataFile }, windowsHide: true, encoding: 'utf8', timeout: 15000,
      input: [
        {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_tasks',arguments:{}}},
        {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'create_task',arguments:{content:'must not overwrite'}}},
      ].map(JSON.stringify).join('\n') + '\n',
    });
    assert.equal(damaged.status, 0, damaged.stderr || String(damaged.error));
    const responses = damaged.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(responses.length, 2);
    assert(responses.every(r => r.result.isError), damaged.stdout);
    assert.equal(fs.readFileSync(dataFile, 'utf8'), '{broken-json');
    console.log('PASS: cold-start damaged data rejects reads/writes without replacing the original file');
    console.log('PASS: native MCP initialize, 11 tools, isolated storage, create, cycle rejection, tree, cascade complete, cascade delete, persisted JSON');
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    if (child.exitCode === null) await once(child, 'exit');
    clearTimeout(timer);
    for (const { timer } of pending.values()) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
