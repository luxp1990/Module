// Module MCP Server — 自动化回归与完整性测试脚本
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const serverScript = path.join(__dirname, '..', 'mcp-server', 'server.js');

function createMcpClient() {
  const child = spawn(process.execPath, [serverScript], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({
    input: child.stdout,
    terminal: false
  });

  let reqId = 1;
  const pending = new Map();

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const resp = JSON.parse(line);
      if (resp.id && pending.has(resp.id)) {
        const { resolve, reject } = pending.get(resp.id);
        pending.delete(resp.id);
        if (resp.error) reject(new Error(resp.error.message));
        else resolve(resp.result);
      }
    } catch (_) {}
  });

  child.stderr.on('data', (d) => {
    // 调试日志输出（可选）
    // process.stderr.write(d);
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function close() {
    child.stdin.end();
    child.kill();
  }

  return { send, close };
}

async function runTests() {
  console.log('[TEST] Starting MCP Server test suite...');
  const client = createMcpClient();

  try {
    // 1. 初始化握手
    console.log('[TEST] 1. Testing initialize...');
    const initRes = await client.send('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'test-runner', version: '1.0.0' }
    });
    assert.strictEqual(initRes.serverInfo.name, 'module-taskmanager-mcp');
    assert.ok(initRes.capabilities.tools);
    console.log('  -> Initialize passed!');

    // 2. 存活检查
    console.log('[TEST] 2. Testing ping...');
    const pingRes = await client.send('ping');
    assert.deepStrictEqual(pingRes, {});
    console.log('  -> Ping passed!');

    // 3. 工具清单检查
    console.log('[TEST] 3. Testing tools/list...');
    const toolsRes = await client.send('tools/list');
    assert.ok(Array.isArray(toolsRes.tools));
    assert.strictEqual(toolsRes.tools.length, 11);
    const names = toolsRes.tools.map(t => t.name);
    assert.ok(names.includes('create_task'));
    assert.ok(names.includes('get_tasks'));
    assert.ok(names.includes('get_task_tree'));
    assert.ok(names.includes('update_task'));
    assert.ok(names.includes('delete_task'));
    assert.ok(names.includes('get_deadline_buckets'));
    assert.ok(names.includes('manage_notes'));
    console.log(`  -> tools/list passed! Found ${toolsRes.tools.length} registered tools.`);

    // 4. 调用 get_tasks
    console.log('[TEST] 4. Testing get_tasks tool call...');
    const getRes = await client.send('tools/call', {
      name: 'get_tasks',
      arguments: { limit: 5 }
    });
    assert.strictEqual(getRes.isError, false);
    const getParsed = JSON.parse(getRes.content[0].text);
    assert.ok(Array.isArray(getParsed.tasks));
    console.log(`  -> get_tasks passed! Current tasks count: ${getParsed.total}`);

    // 5. 调用 create_task
    console.log('[TEST] 5. Testing create_task...');
    const createRes = await client.send('tools/call', {
      name: 'create_task',
      arguments: {
        content: 'MCP自动化测试任务-' + Date.now(),
        priority: 'p0',
        deadline: '2026-11-10',
        notes: '由 MCP 单元测试自动创建'
      }
    });
    assert.strictEqual(createRes.isError, false);
    const createdParsed = JSON.parse(createRes.content[0].text);
    assert.strictEqual(createdParsed.success, true);
    assert.ok(createdParsed.task.id);
    const createdId = createdParsed.task.id;
    console.log(`  -> create_task passed! Created taskId: ${createdId}`);

    // 6. 调用 update_task
    console.log('[TEST] 6. Testing update_task...');
    const updateRes = await client.send('tools/call', {
      name: 'update_task',
      arguments: {
        id: createdId,
        content: 'MCP自动化测试任务-已修改',
        priority: 'p2'
      }
    });
    assert.strictEqual(updateRes.isError, false);
    const updatedParsed = JSON.parse(updateRes.content[0].text);
    assert.strictEqual(updatedParsed.task.priority, 'p2');
    console.log('  -> update_task passed!');

    // 7. 调用 complete_task
    console.log('[TEST] 7. Testing complete_task...');
    const completeRes = await client.send('tools/call', {
      name: 'complete_task',
      arguments: { id: createdId, completed: true }
    });
    assert.strictEqual(completeRes.isError, false);
    const completedParsed = JSON.parse(completeRes.content[0].text);
    assert.strictEqual(completedParsed.task.completed, true);
    console.log('  -> complete_task passed!');

    // 8. 调用 get_deadline_buckets
    console.log('[TEST] 8. Testing get_deadline_buckets...');
    const bucketRes = await client.send('tools/call', {
      name: 'get_deadline_buckets',
      arguments: {}
    });
    assert.strictEqual(bucketRes.isError, false);
    const bucketParsed = JSON.parse(bucketRes.content[0].text);
    assert.ok(bucketParsed.todayStr);
    assert.ok(Array.isArray(bucketParsed.today));
    console.log('  -> get_deadline_buckets passed!');

    // 8.1 调用 get_task_tree
    console.log('[TEST] 8.1 Testing get_task_tree...');
    const treeRes = await client.send('tools/call', {
      name: 'get_task_tree',
      arguments: { activeOnly: false }
    });
    assert.strictEqual(treeRes.isError, false);
    const treeParsed = JSON.parse(treeRes.content[0].text);
    assert.ok(Array.isArray(treeParsed.tree));
    console.log(`  -> get_task_tree passed! Roots count: ${treeParsed.tree.length}`);

    // 8.2 调用 get_gantt_data
    console.log('[TEST] 8.2 Testing get_gantt_data...');
    const ganttRes = await client.send('tools/call', {
      name: 'get_gantt_data',
      arguments: {}
    });
    assert.strictEqual(ganttRes.isError, false);
    const ganttParsed = JSON.parse(ganttRes.content[0].text);
    assert.ok(Array.isArray(ganttParsed.tasks));
    console.log(`  -> get_gantt_data passed! Gantt tasks: ${ganttParsed.totalCount}`);

    // 8.3 调用 batch_create_tasks
    console.log('[TEST] 8.3 Testing batch_create_tasks...');
    const batchRes = await client.send('tools/call', {
      name: 'batch_create_tasks',
      arguments: {
        tasks: [
          { content: '批量子任务A-' + Date.now(), priority: 'p1' },
          { content: '批量子任务B-' + Date.now(), priority: 'p2' }
        ]
      }
    });
    assert.strictEqual(batchRes.isError, false);
    const batchParsed = JSON.parse(batchRes.content[0].text);
    assert.strictEqual(batchParsed.count, 2);
    for (const bTask of batchParsed.tasks) {
      await client.send('tools/call', { name: 'delete_task', arguments: { id: bTask.id } });
    }
    console.log('  -> batch_create_tasks passed & cleaned up!');

    // 8.4 调用 get_weekly_report
    console.log('[TEST] 8.4 Testing get_weekly_report...');
    const reportRes = await client.send('tools/call', {
      name: 'get_weekly_report',
      arguments: {}
    });
    assert.strictEqual(reportRes.isError, false);
    const reportParsed = JSON.parse(reportRes.content[0].text);
    assert.ok(reportParsed.weekId);
    console.log(`  -> get_weekly_report passed! WeekId: ${reportParsed.weekId}`);

    // 9. 调用 manage_notes
    console.log('[TEST] 9. Testing manage_notes...');
    const noteCreateRes = await client.send('tools/call', {
      name: 'manage_notes',
      arguments: {
        action: 'create',
        content: 'MCP测试便签-' + Date.now(),
        pinned: true
      }
    });
    assert.strictEqual(noteCreateRes.isError, false);
    const noteParsed = JSON.parse(noteCreateRes.content[0].text);
    assert.ok(noteParsed.note.id);
    const noteId = noteParsed.note.id;

    // 清理便签
    await client.send('tools/call', {
      name: 'manage_notes',
      arguments: { action: 'delete', id: noteId }
    });
    console.log('  -> manage_notes passed!');

    // 10. 清理测试任务 delete_task
    console.log('[TEST] 10. Testing delete_task (cleanup)...');
    const deleteRes = await client.send('tools/call', {
      name: 'delete_task',
      arguments: { id: createdId }
    });
    assert.strictEqual(deleteRes.isError, false);
    const deleteParsed = JSON.parse(deleteRes.content[0].text);
    assert.strictEqual(deleteParsed.deletedId, createdId);
    console.log('  -> delete_task passed!');

    console.log('\n[SUCCESS] ALL 10 MCP TEST CASES PASSED PERFECTLY!\n');
  } finally {
    client.close();
  }
}

runTests().catch(err => {
  console.error('[FAIL] Test failed:', err);
  process.exit(1);
});
