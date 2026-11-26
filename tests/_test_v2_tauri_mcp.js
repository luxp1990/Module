// Automated end-to-end test suite for Module 2.0 (Tauri / Rust Native Binary MCP)
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const exePath = path.resolve(__dirname, '../src-tauri/target/release/module.exe');

async function runTests() {
  console.log('Testing Native Tauri v2.0 Binary MCP:', exePath);
  const child = spawn(exePath, ['--mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });

  let buffer = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep remainder
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (err) {
        console.error('JSON parse error on line:', trimmed, err);
      }
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      child.stdin.write(req);
    });
  }

  let passed = 0;

  // 1. Initialize
  const initRes = await send('initialize', {});
  assert.strictEqual(initRes.serverInfo.name, 'Module-MCP-Server');
  assert.strictEqual(initRes.serverInfo.version, '2.1.4');
  console.log('✓ Test 1 Passed: MCP Initialize');
  passed++;

  // 2. Tools list
  const listRes = await send('tools/list', {});
  assert.strictEqual(listRes.tools.length, 11);
  console.log(`✓ Test 2 Passed: tools/list registered 11 tools`);
  passed++;

  // 3. get_tasks
  const getTasksRes = await send('tools/call', { name: 'get_tasks', arguments: { limit: 5 } });
  const tasksObj = JSON.parse(getTasksRes.content[0].text);
  assert(Array.isArray(tasksObj.tasks));
  console.log(`✓ Test 3 Passed: get_tasks returned ${tasksObj.tasks.length} items`);
  passed++;

  // 4. create_task
  const createRes = await send('tools/call', {
    name: 'create_task',
    arguments: {
      content: 'Tauri 2.0 自动化测试任务',
      priority: 'p0',
      startDate: '2026-11-04',
      deadline: '2026-11-10',
      notes: 'v2.0.0 end-to-end assertion'
    }
  });
  const createdTask = JSON.parse(createRes.content[0].text);
  assert(createdTask.id);
  assert.strictEqual(createdTask.content, 'Tauri 2.0 自动化测试任务');
  console.log(`✓ Test 4 Passed: create_task id=${createdTask.id}`);
  passed++;

  // 5. update_task
  const updateRes = await send('tools/call', {
    name: 'update_task',
    arguments: {
      id: createdTask.id,
      updates: {
        content: 'Tauri 2.0 自动化测试任务 (已更新)',
        notes: 'Updated notes'
      }
    }
  });
  const updatedTask = JSON.parse(updateRes.content[0].text);
  assert.strictEqual(updatedTask.content, 'Tauri 2.0 自动化测试任务 (已更新)');
  console.log('✓ Test 5 Passed: update_task');
  passed++;

  // 6. get_task_tree
  const treeRes = await send('tools/call', { name: 'get_task_tree', arguments: {} });
  const treeObj = JSON.parse(treeRes.content[0].text);
  assert(Array.isArray(treeObj.tree));
  console.log(`✓ Test 6 Passed: get_task_tree returned ${treeObj.tree.length} root nodes`);
  passed++;

  // 7. complete_task
  const completeRes = await send('tools/call', { name: 'complete_task', arguments: { id: createdTask.id } });
  const compObj = JSON.parse(completeRes.content[0].text);
  assert.strictEqual(compObj.task.completed, true);
  console.log('✓ Test 7 Passed: complete_task');
  passed++;

  // 8. delete_task
  const deleteRes = await send('tools/call', { name: 'delete_task', arguments: { id: createdTask.id } });
  const delObj = JSON.parse(deleteRes.content[0].text);
  assert(delObj.deletedIds.includes(createdTask.id));
  console.log('✓ Test 8 Passed: delete_task cleaned up successfully');
  passed++;

  // 9. get_deadline_buckets
  const bucketsRes = await send('tools/call', { name: 'get_deadline_buckets', arguments: {} });
  const buckets = JSON.parse(bucketsRes.content[0].text);
  assert(Array.isArray(buckets.overdue));
  assert(Array.isArray(buckets.today));
  console.log('✓ Test 9 Passed: get_deadline_buckets');
  passed++;

  // 10. get_gantt_data
  const ganttRes = await send('tools/call', { name: 'get_gantt_data', arguments: {} });
  const gantt = JSON.parse(ganttRes.content[0].text);
  assert(Array.isArray(gantt));
  console.log(`✓ Test 10 Passed: get_gantt_data returned ${gantt.length} tasks`);
  passed++;

  // 11. get_weekly_report
  const reportRes = await send('tools/call', { name: 'get_weekly_report', arguments: {} });
  const report = JSON.parse(reportRes.content[0].text);
  assert(report.weekId);
  console.log(`✓ Test 11 Passed: get_weekly_report for ${report.weekId}`);
  passed++;

  // 12. manage_notes
  const notesRes = await send('tools/call', { name: 'manage_notes', arguments: { action: 'list' } });
  const notes = JSON.parse(notesRes.content[0].text);
  assert(Array.isArray(notes.notes));
  console.log(`✓ Test 12 Passed: manage_notes listed ${notes.notes.length} notes`);
  passed++;

  child.stdin.end();
  child.kill();

  console.log(`\n========================================`);
  console.log(`ALL ${passed}/12 TAURI V2.0 MCP TESTS PASSED!`);
  console.log(`========================================\n`);
}

runTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
