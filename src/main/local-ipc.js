// Module — 本地进程间通信 (Local IPC for MCP Server & CLI)
// 使用操作系统原生 Named Pipe (Windows) / Unix Domain Socket (POSIX)
'use strict';

const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 多用户隔离：管道名称带上当前系统用户名，防止同机多用户冲突
const userSuffix = (process.env.USERNAME || process.env.USER || 'default')
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, '_');

const PIPE_NAME = process.platform === 'win32'
  ? `\\\\.\\pipe\\module-taskmanager-ipc-${userSuffix}`
  : path.join(os.tmpdir(), `module-taskmanager-ipc-${userSuffix}.sock`);

const MAX_BUFFER_SIZE = 5 * 1024 * 1024; // 5MB 最大防溢出限制

let serverInstance = null;

async function handleIpcRequest(msg, store, broadcastDataChanged, app, options = {}) {
  const notify = patch => {
    if (typeof broadcastDataChanged === 'function') {
      broadcastDataChanged(patch.action.startsWith('TASK') ? { ...patch, reloadTasks: true } : patch);
    }
  };
  const method = msg.method;
  const params = msg.params || {};

  switch (method) {
    case 'ping':
      return {
        status: 'online',
        version: app && typeof app.getVersion === 'function' ? app.getVersion() : '1.7.7',
        pid: process.pid
      };

    case 'tasks:getAll':
      return store.getAll();

    case 'tasks:getActive':
      return store.getActive();

    case 'tasks:getCompleted':
      return store.getCompleted();

    case 'tasks:create': {
      if (typeof options.pushUndo === 'function') options.pushUndo('新建任务(MCP)');
      const res = store.createTask(params);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'TASK_CREATED', id: res.id, payload: res });
      }
      return res;
    }

    case 'tasks:batchCreate': {
      const list = Array.isArray(params) ? params : (params.tasks || []);
      if (typeof options.pushUndo === 'function') options.pushUndo(`新建 ${list.length} 个任务(MCP)`);
      const res = store.batchCreateTasks(list);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'TASKS_BATCH_CREATED', ids: res.map(t => t.id), payload: res });
      }
      return res;
    }

    case 'tasks:update': {
      if (typeof options.pushUndo === 'function') options.pushUndo('更新任务(MCP)');
      const res = store.updateTask(params.id, params.updates || params);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'TASK_UPDATED', id: params.id, payload: res });
      }
      return res;
    }

    case 'tasks:complete': {
      if (typeof options.pushUndo === 'function') options.pushUndo('完成任务(MCP)');
      const res = store.completeTask(params.id);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'TASK_COMPLETED', id: params.id, payload: { ids: res.map(t => t.id) } });
      }
      return res;
    }

    case 'tasks:uncomplete': {
      if (typeof options.pushUndo === 'function') options.pushUndo('恢复任务(MCP)');
      const res = store.uncompleteTask(params.id);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'TASK_UNCOMPLETED', id: params.id, payload: res });
      }
      return res;
    }

    case 'tasks:delete': {
      if (typeof options.pushUndo === 'function') options.pushUndo('删除任务(MCP)');
      const res = store.deleteTask(params.id);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'TASK_DELETED', id: params.id, ids: res.deleted, payload: res });
      }
      return res;
    }

    case 'gantt:data':
      return store.getGanttData();

    case 'reports:get':
      return store.getWeeklyReport(params.weekId);

    case 'reports:generate': {
      const res = store.generateWeeklyReport(params.weekId);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'REPORT_CREATED', id: params.weekId });
      }
      return res;
    }

    case 'reports:currentWeekId':
      return store.getWeekId(new Date());

    case 'notes:list':
      return store.getNotes();

    case 'notes:create': {
      const res = store.createNote(params);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'NOTE_CREATED', id: res.id });
      }
      return res;
    }

    case 'notes:update': {
      const res = store.updateNote(params.id, params.updates || params);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'NOTE_UPDATED', id: params.id, payload: params.updates });
      }
      return res;
    }

    case 'notes:delete': {
      const res = store.deleteNote(params.id);
      if (typeof broadcastDataChanged === 'function') {
        notify({ action: 'NOTE_DELETED', id: params.id });
      }
      return res;
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function startLocalIpcServer(store, broadcastDataChanged, app, options = {}) {
  if (serverInstance) return;

  if (process.platform !== 'win32' && fs.existsSync(PIPE_NAME)) {
    try { fs.unlinkSync(PIPE_NAME); } catch (_) {}
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    const queue = [];
    let processing = false;

    async function processQueue() {
      if (processing) return;
      processing = true;
      while (queue.length > 0) {
        const line = queue.shift();
        let msg = null;
        try {
          msg = JSON.parse(line);
          const result = await handleIpcRequest(msg, store, broadcastDataChanged, app, options);
          if (!socket.destroyed && socket.writable) {
            socket.write(JSON.stringify({ id: msg.id, success: true, result }) + '\n');
          }
        } catch (err) {
          if (!socket.destroyed && socket.writable) {
            socket.write(JSON.stringify({ id: msg ? msg.id : null, success: false, error: err.message }) + '\n');
          }
        }
      }
      processing = false;
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_BUFFER_SIZE) {
        buffer = '';
        socket.destroy();
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) queue.push(line);
      }
      processQueue();
    });

    socket.on('error', () => {
      // 客户端断开连接，静默关闭
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn('[local-ipc] Pipe already in use, skipping local IPC server.');
    } else {
      console.error('[local-ipc] Server error:', err.message);
    }
  });

  try {
    server.listen(PIPE_NAME, () => {
      console.log('[local-ipc] Listening on ' + PIPE_NAME);
    });
    serverInstance = server;
  } catch (err) {
    console.error('[local-ipc] Failed to listen:', err.message);
  }
}

function stopLocalIpcServer() {
  if (serverInstance) {
    try {
      serverInstance.close();
      if (process.platform !== 'win32' && fs.existsSync(PIPE_NAME)) {
        try { fs.unlinkSync(PIPE_NAME); } catch (_) {}
      }
    } catch (_) {}
    serverInstance = null;
  }
}

// 客户端调用封装（供 mcp-server 或 cli 测试）
function callLocalIpc(method, params = {}, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PIPE_NAME);
    const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    let resolved = false;
    let buffer = '';

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        reject(new Error(`Local IPC timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: reqId, method, params }) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.id === reqId) {
            resolved = true;
            clearTimeout(timer);
            socket.end();
            if (resp.success) {
              resolve(resp.result);
            } else {
              reject(new Error(resp.error || 'Unknown IPC error'));
            }
            return;
          }
        } catch (_) {}
      }
    });

    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

module.exports = {
  PIPE_NAME,
  startLocalIpcServer,
  stopLocalIpcServer,
  callLocalIpc,
};
