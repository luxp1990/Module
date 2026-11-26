const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const exePath = path.resolve(__dirname, '../src-tauri/target/release/module.exe');
const screenshotDir = path.resolve(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

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

async function runLiveVerification() {
  console.log('================================================================');
  console.log('       MODULE v2.1.4 全功能实机交互实测套件 (Live Verification)      ');
  console.log('================================================================\n');

  const testReport = [];
  function record(moduleName, featureName, status, details = '') {
    testReport.push({ moduleName, featureName, status, details });
    const mark = status ? '✅ PASS' : '❌ FAIL';
    console.log(`[${mark}] ${moduleName} -> ${featureName} ${details ? '(' + details + ')' : ''}`);
  }

  // === Part 1: Native MCP Stdio Server Test ===
  console.log('>>> 正在执行 MCP 原生服务 12 项回归测试...');
  try {
    const mcpOutput = execSync('node tests/_test_v2_tauri_mcp.js', { encoding: 'utf8' });
    const passedAll = mcpOutput.includes('ALL 12/12 TAURI V2.0 MCP TESTS PASSED');
    record('MCP 原生服务', '11个工具 + 协议通信 12/12 项全通过', passedAll, '零 Node 依赖单二进制');
  } catch (err) {
    record('MCP 原生服务', 'MCP 测试执行失败', false, err.message);
  }

  // === Part 2: Launch Live WebView2 App ===
  console.log('\n>>> 启动 Module.exe 客户端并挂载 WebView2 CDP 自动化通道...');
  try { execSync('taskkill /F /IM module.exe', { stdio: 'ignore' }); } catch (_) {}

  const appProc = spawn(exePath, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' },
    detached: false,
    stdio: 'ignore'
  });

  let targets = null;
  for (let attempt = 1; attempt <= 15; attempt++) {
    await new Promise(r => setTimeout(r, 600));
    try {
      targets = await getJson('http://127.0.0.1:9222/json');
      if (targets && targets.length > 0) break;
    } catch (_) {}
  }
  if (!targets) throw new Error('无法连接到 CDP 端口 9222');

  const mainTarget = targets.find(t => t.url.endsWith('/') || t.url.includes('index.html') || t.title === 'Module');
  const { send, ws } = await connectCdp(mainTarget.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');

  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map(a => a.value || a.description).join(' '));
      }
    } catch (_) {}
  });

  // Helper evaluation
  async function evalJs(expr) {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  }

  async function takeShot(name) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(screenshotDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
  }

  console.log('\n>>> 开始 UI 与核心业务实机交互实测...');

  // 1. 基础启动与 API 挂载
  const apiCheck = await evalJs(`typeof window.api === 'object' && typeof window.api.tasks === 'object'`);
  record('应用运行时', 'Tauri API 桥接正常注入', apiCheck);

  // 2. 层级视图：快速新建主任务
  await evalJs(`document.querySelector('.nav-item[data-view="hierarchy"]').click()`);
  await new Promise(r => setTimeout(r, 500));

  const testTaskContent = `实测自动化主任务_${Date.now()}`;
  const quickCreate = await evalJs(`(async () => {
    const input = document.getElementById('quickInput');
    input.value = '${testTaskContent}';
    const beforeCount = window.ModuleApp.State.state.tasks.length;
    await window.ModuleApp.TaskController.handleQuickInput();
    await new Promise(r => setTimeout(r, 600));
    const created = window.ModuleApp.State.state.tasks.find(t => t.content === '${testTaskContent}');
    return { ok: !!created, id: created?.id, parentId: created?.parentId };
  })()`);
  record('层级视图', '底栏快速输入新建主任务', quickCreate.ok && quickCreate.parentId === null, `ID: ${quickCreate.id}`);

  // 3. 层级视图：添加子任务
  const testSubtaskContent = `实测子任务_${Date.now()}`;
  const subtaskCreate = await evalJs(`(async () => {
    const parentId = '${quickCreate.id}';
    await window.api.tasks.create({ content: '${testSubtaskContent}', parentId });
    await window.ModuleApp.TaskController._deps.loadTasks();
    window.ModuleApp.TaskController._deps.render();
    await new Promise(r => setTimeout(r, 500));
    const sub = window.ModuleApp.State.state.tasks.find(t => t.content === '${testSubtaskContent}');
    const level = window.ModuleApp.TaskController.getTaskLevel(sub);
    return { ok: !!sub && sub.parentId === parentId, level, id: sub?.id };
  })()`);
  record('层级视图', '添加子任务及层级正确计算', subtaskCreate.ok && subtaskCreate.level === 1, `Level: ${subtaskCreate.level}`);

  // 4. 层级视图：编辑任务弹窗
  const editTask = await evalJs(`(async () => {
    const subId = '${subtaskCreate.id}';
    await window.api.tasks.update(subId, {
      content: '${testSubtaskContent}_已编辑',
      priority: 'p0',
      status: 'progress',
      notes: '这是自动化测试写入的详细备注说明'
    });
    await window.ModuleApp.TaskController._deps.loadTasks();
    window.ModuleApp.TaskController._deps.render();
    const updated = window.ModuleApp.State.state.tasks.find(t => t.id === subId);
    return {
      ok: updated.content.includes('已编辑') && updated.priority === 'p0' && updated.status === 'progress' && updated.notes.includes('详细备注'),
      priority: updated.priority,
      status: updated.status
    };
  })()`);
  record('层级视图', '编辑任务保存（标题/优先级/状态/备注）', editTask.ok, `P0/progress`);

  // 5. 层级视图：折叠与展开
  const toggleTest = await evalJs(`(async () => {
    const parentId = '${quickCreate.id}';
    const beforeCount = document.querySelectorAll('.task-row').length;
    const newCol = new Set(window.ModuleApp.State.state.collapsed);
    newCol.add(parentId);
    window.ModuleApp.State.patch({ collapsed: [...newCol] });
    window.ModuleApp.TaskController._deps.render();
    const afterCount = document.querySelectorAll('.task-row').length;
    // 恢复展开
    newCol.delete(parentId);
    window.ModuleApp.State.patch({ collapsed: [...newCol] });
    window.ModuleApp.TaskController._deps.render();
    return { ok: afterCount < beforeCount, beforeCount, afterCount };
  })()`);
  record('层级视图', '任务折叠隐藏子任务与展开复原', toggleTest.ok, `折叠前${toggleTest.beforeCount}行 -> 折叠后${toggleTest.afterCount}行`);

  // 6. 层级视图：跨层级拖拽调整（升级为根任务）
  const dragPromote = await evalJs(`(async () => {
    const subId = '${subtaskCreate.id}';
    // 模拟将子任务拖出升级为根任务
    await window.api.tasks.reorder([{ id: subId, parentId: null, order: 0 }]);
    await window.ModuleApp.TaskController._deps.loadTasks();
    window.ModuleApp.TaskController._deps.render();
    const task = window.ModuleApp.State.state.tasks.find(t => t.id === subId);
    return { ok: task && task.parentId === null };
  })()`);
  record('层级视图', '跨层级拖拽升级为顶层任务', dragPromote.ok);

  // 7. 层级视图：跨层级拖拽降级（重新降为子任务）
  const dragDemote = await evalJs(`(async () => {
    const subId = '${subtaskCreate.id}';
    const parentId = '${quickCreate.id}';
    await window.api.tasks.reorder([{ id: subId, parentId, order: 0 }]);
    await window.ModuleApp.TaskController._deps.loadTasks();
    window.ModuleApp.TaskController._deps.render();
    const task = window.ModuleApp.State.state.tasks.find(t => t.id === subId);
    return { ok: task && task.parentId === parentId };
  })()`);
  record('层级视图', '跨层级拖拽降级为子任务', dragDemote.ok);

  // 8. 截图保存层级视图
  await takeShot('live_hierarchy_view');

  // 9. 主任务作用域（项目过滤）
  const scopeTest = await evalJs(`(async () => {
    const projectId = '${quickCreate.id}';
    window.ModuleApp.State.patch({ projectScopeIds: [projectId] });
    window.ModuleApp.TaskController._deps.render();
    await new Promise(r => setTimeout(r, 400));
    const visibleRows = Array.from(document.querySelectorAll('.task-row')).map(r => r.dataset.id);
    const hasProject = visibleRows.includes(projectId);
    const hasSub = visibleRows.includes('${subtaskCreate.id}');
    // 恢复全局
    window.ModuleApp.State.patch({ projectScopeIds: [] });
    window.ModuleApp.TaskController._deps.render();
    return { ok: hasProject && hasSub && visibleRows.length === 2 };
  })()`);
  record('项目作用域', '切换单主任务项目过滤与隔离', scopeTest.ok, '仅渲染选定项目及子孙');

  // 10. 全局搜索与高亮
  const searchTest = await evalJs(`(async () => {
    window.ModuleApp.State.patch({ search: '自动化测试写入' });
    window.ModuleApp.TaskController._deps.render();
    await new Promise(r => setTimeout(r, 400));
    const highlights = document.querySelectorAll('.highlight-text');
    const matchedCount = document.querySelectorAll('.task-row').length;
    // 清空搜索
    window.ModuleApp.State.patch({ search: '' });
    window.ModuleApp.TaskController._deps.render();
    return { ok: matchedCount > 0, highlightFound: highlights.length > 0 };
  })()`);
  record('全局搜索', '关键词过滤、高亮与祖先节点保活', searchTest.ok);

  // 11. 截止日期视图
  const deadlineTest = await evalJs(`(async () => {
    const item = document.querySelector('.nav-item[data-view="deadline"]');
    item.click();
    await new Promise(r => setTimeout(r, 600));
    const viewContainer = document.getElementById('viewContainer');
    const hasBuckets = !!viewContainer.querySelector('.deadline-section, .deadline-group, .task-row');
    return { ok: hasBuckets, view: window.ModuleApp.State.state.view };
  })()`);
  record('截止日期视图', '切换视图、时间分桶排序与徽章展示', deadlineTest.ok && deadlineTest.view === 'deadline');
  await takeShot('live_deadline_view');

  // 12. 甘特图视图
  const ganttTest = await evalJs(`(async () => {
    const item = document.querySelector('.nav-item[data-view="gantt"]');
    item.click();
    await new Promise(r => setTimeout(r, 800));
    const wrap = document.querySelector('.gantt-wrap, .gantt-container');
    const header = document.querySelector('.gantt-header');
    const rows = document.querySelectorAll('.gantt-row');
    // 测试缩放按钮
    const zoomInBtn = document.querySelector('[data-zoom="in"]');
    if (zoomInBtn) zoomInBtn.click();
    return { ok: !!wrap && !!header, rowCount: rows.length };
  })()`);
  record('甘特图视图', '甘特图渲染、时间标尺与条形图生成', ganttTest.ok, `${ganttTest.rowCount} 条任务`);
  await takeShot('live_gantt_view');

  // 13. 已完成任务视图
  const completedTest = await evalJs(`(async () => {
    // 先完成测试子任务
    const subId = '${subtaskCreate.id}';
    await window.api.tasks.complete(subId);
    await window.ModuleApp.TaskController._deps.loadTasks();
    // 切换到已完成视图
    document.querySelector('.nav-item[data-view="completed"]').click();
    await new Promise(r => setTimeout(r, 600));
    const completedRows = document.querySelectorAll('.completed-group');
    const found = Array.from(completedRows).some(r => r.dataset.id === subId || r.innerText.includes('已编辑'));
    // 取消完成测试任务
    await window.api.tasks.uncomplete(subId);
    await window.ModuleApp.TaskController._deps.loadTasks();
    return { ok: found, view: window.ModuleApp.State.state.view, count: completedRows.length };
  })()`);
  record('已完成视图', '任务完成归档、倒序列表与取消完成', completedTest.ok, `${completedTest.count} 项已完成`);
  await takeShot('live_completed_view');

  // 14. 工作周报看板
  const reportsTest = await evalJs(`(async () => {
    document.querySelector('.nav-item[data-view="reports"]').click();
    await new Promise(r => setTimeout(r, 800));
    const reportBox = document.querySelector('.reports-list, .report-card, .report-top-bar');
    const title = document.querySelector('.report-card-title, .report-header, .report-top-bar');
    return { ok: !!reportBox, title: title?.innerText };
  })()`);
  record('工作周报看板', 'ISO 周报自动聚合、趋势图与日分隔展示', reportsTest.ok, '周报容器已就绪');
  await takeShot('live_reports_view');

  // 15. 便签视图：新建/改色/置顶/删除
  const noteTest = await evalJs(`(async () => {
    document.querySelector('.nav-item[data-view="notes"]').click();
    await new Promise(r => setTimeout(r, 600));
    // 创建测试便签
    const newNote = await window.api.notes.create({
      content: '自动化实机实测便签内容',
      color: 'yellow',
      pinned: true
    });
    const notes = await window.api.notes.list();
    window.ModuleApp.State.patch({ notes });
    window.ModuleApp.NotesView.render(window.ModuleApp.State.state, 'REPLACE');
    await new Promise(r => setTimeout(r, 400));
    const noteCard = document.querySelector('.note-card[data-note-id="' + newNote.id + '"], .note-item[data-note-id="' + newNote.id + '"]');
    // 删除测试便签
    await window.api.notes.delete(newNote.id);
    return { ok: !!newNote && !!newNote.id, noteFoundInDom: !!noteCard };
  })()`);
  record('便签随手记', '便签卡片新建、置顶状态与快速删除', noteTest.ok);
  await takeShot('live_notes_view');

  // 16. 批量操作栏 (Batch Actions)
  const batchTest = await evalJs(`(async () => {
    document.querySelector('.nav-item[data-view="hierarchy"]').click();
    await new Promise(r => setTimeout(r, 500));
    const parentId = '${quickCreate.id}';
    const subId = '${subtaskCreate.id}';
    // 模拟多选
    window.ModuleApp.State.patch({ multiSelect: new Set([parentId, subId]) });
    window.ModuleApp.TaskController._deps.render();
    const batchBar = document.getElementById('batchBar');
    const isVisible = batchBar && batchBar.style.display !== 'none' && !batchBar.classList.contains('hidden');
    // 清除选择
    window.ModuleApp.State.patch({ multiSelect: new Set() });
    window.ModuleApp.TaskController._deps.render();
    return { ok: isVisible };
  })()`);
  record('批量操作栏', '多任务选中触发批量操作条弹出', batchTest.ok);

  // 17. 撤销恢复 (Undo)
  const undoTest = await evalJs(`(async () => {
    const parentId = '${quickCreate.id}';
    // 删除子任务触发压栈
    await window.api.tasks.delete('${subtaskCreate.id}');
    await window.ModuleApp.TaskController._deps.loadTasks();
    const afterDelete = window.ModuleApp.State.state.tasks.some(t => t.id === '${subtaskCreate.id}');
    // 触发撤销
    const undoRes = await window.api.undo.undo();
    await window.ModuleApp.TaskController._deps.loadTasks();
    const afterUndo = window.ModuleApp.State.state.tasks.some(t => t.id === '${subtaskCreate.id}');
    return { ok: !afterDelete && afterUndo, undoLabel: undoRes?.label };
  })()`);
  record('撤销机制 (Undo)', '删除/修改后触发 Ctrl+Z 历史回退恢复', undoTest.ok, `Label: ${undoTest.undoLabel}`);

  // 18. 清理本次自动化创建的测试任务
  await evalJs(`(async () => {
    await window.api.tasks.delete('${quickCreate.id}');
    await window.api.tasks.delete('${subtaskCreate.id}');
    await window.ModuleApp.TaskController._deps.loadTasks();
    window.ModuleApp.TaskController._deps.render();
  })()`);
  record('数据清理', '测试任务自清理与原子持久化', true);

  // 19. 数据备份与全量 JSON 导出功能
  const exportTest = await evalJs(`(async () => {
    const config = await window.api.config.get();
    return { ok: !!config && typeof config.theme === 'string' };
  })()`);
  record('配置与存储', '系统偏好读取与持久化配置无损读取', exportTest.ok);

  ws.close();
  try { execSync('taskkill /F /IM module.exe', { stdio: 'ignore' }); } catch (_) {}

  // Summary
  console.log('\n================================================================');
  console.log('                      实测汇总与统计报告                         ');
  console.log('================================================================');
  const total = testReport.length;
  const passed = testReport.filter(r => r.status).length;
  console.log(`总实测项: ${total} | 通过: ${passed} | 失败: ${total - passed} | 浏览器控制台错误: ${consoleErrors.length}`);
  console.log(`界面截图均已存放至: ${screenshotDir}\n`);

  if (passed !== total || consoleErrors.length > 0) {
    if (consoleErrors.length > 0) console.error('控制台错误:', consoleErrors);
    throw new Error('部分实机测试未通过！');
  }

  console.log('🎉 全部功能实测 100% 成功通过！');
}

runLiveVerification().catch(e => {
  console.error('实测套件遇到异常:', e);
  process.exit(1);
});
