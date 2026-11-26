// Module MCP Server — 混合双模数据桥接 (Online / Offline Hybrid Bridge)
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { callLocalIpc } = require('../src/main/local-ipc');
const DataStore = require('../src/main/data-store');
const DeadlineBuckets = require('../src/shared/deadline-buckets');

// 定位本地数据文件路径
function resolveDataFilePath() {
  if (process.env.MODULE_DATA_PATH && fs.existsSync(process.env.MODULE_DATA_PATH)) {
    return process.env.MODULE_DATA_PATH;
  }
  const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
  const candidates = [
    path.join(appData, 'task-manager', 'tasks-data.json'),
    path.join(appData, 'Module', 'tasks-data.json'),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return candidates[0];
}

// 离线写盘带 EBUSY / EPERM 指数重试（防御 Windows OneDrive 或杀软临界锁盘）
function safeSyncSaveWithRetry(store, maxRetries = 3, retryDelayMs = 40) {
  if (store._saveTimeout) {
    clearTimeout(store._saveTimeout);
    store._saveTimeout = null;
  }
  let retries = maxRetries;
  while (retries > 0) {
    try {
      store._forceSaveSync();
      return;
    } catch (err) {
      retries--;
      if (retries === 0) throw err;
      const end = Date.now() + retryDelayMs;
      while (Date.now() < end) {}
    }
  }
}

class DataBridge {
  constructor() {
    this.dataFile = resolveDataFilePath();
    this._offlineStore = null;
    this._lastMtime = 0;
  }

  // 获取离线 DataStore 实例 (缓存单例并做按需加载)
  _getOfflineStore() {
    let currentMtime = 0;
    try {
      if (fs.existsSync(this.dataFile)) {
        currentMtime = fs.statSync(this.dataFile).mtimeMs;
      }
    } catch (_) {}

    if (!this._offlineStore) {
      const dir = path.dirname(this.dataFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this._offlineStore = new DataStore(this.dataFile);
      this._offlineStore.load();
      this._lastMtime = currentMtime;
    } else if (currentMtime > this._lastMtime) {
      this._offlineStore.load();
      this._lastMtime = currentMtime;
    }
    return this._offlineStore;
  }

  // 探测 Electron 是否在线
  async isOnline() {
    try {
      const res = await callLocalIpc('ping', {}, 500);
      return res && res.status === 'online';
    } catch (_) {
      return false;
    }
  }

  // 通用双模路由调度
  async _invoke(ipcMethod, offlineHandler, params = {}) {
    try {
      // 优先走 Local Named Pipe
      const res = await callLocalIpc(ipcMethod, params, 800);
      return { data: res, online: true };
    } catch (err) {
      // 离线兜底直接读写 DataStore
      const store = this._getOfflineStore();
      const res = await offlineHandler(store, params);
      // 离线写操作立即同步落盘，清空防抖定时器，且不置 _isDestroyed
      try {
        safeSyncSaveWithRetry(store);
        if (fs.existsSync(this.dataFile)) {
          this._lastMtime = fs.statSync(this.dataFile).mtimeMs;
        }
      } catch (saveErr) {
        console.error('[mcp-bridge] offline sync save failed:', saveErr.message);
      }
      return { data: res, online: false };
    }
  }

  // 1. 查询任务列表
  async getTasks(filters = {}) {
    const { status = 'active', priority, parentId, keyword, scopeId, limit = 50 } = filters;
    const { data: allTasks, online } = await this._invoke('tasks:getAll', (store) => store.getAll());

    let filtered = allTasks || [];
    if (status === 'active') {
      filtered = filtered.filter(t => !t.completed);
    } else if (status === 'completed') {
      filtered = filtered.filter(t => t.completed);
    }

    if (priority) {
      const p = String(priority).toLowerCase();
      filtered = filtered.filter(t => t.priority === p);
    }

    if (parentId !== undefined) {
      if (parentId === 'root' || parentId === null || parentId === '') {
        filtered = filtered.filter(t => !t.parentId);
      } else {
        filtered = filtered.filter(t => t.parentId === parentId);
      }
    }

    if (keyword) {
      const kw = String(keyword).toLowerCase();
      filtered = filtered.filter(t =>
        (t.content && t.content.toLowerCase().includes(kw)) ||
        (t.notes && t.notes.toLowerCase().includes(kw))
      );
    }

    if (scopeId) {
      // 过滤特定主任务及其所有子孙
      const childSet = new Set();
      childSet.add(scopeId);
      let added = true;
      while (added) {
        added = false;
        for (const t of allTasks) {
          if (t.parentId && childSet.has(t.parentId) && !childSet.has(t.id)) {
            childSet.add(t.id);
            added = true;
          }
        }
      }
      filtered = filtered.filter(t => childSet.has(t.id));
    }

    if (limit > 0 && filtered.length > limit) {
      filtered = filtered.slice(0, limit);
    }

    return {
      total: filtered.length,
      onlineMode: online,
      tasks: filtered.map(t => ({
        id: t.id,
        content: t.content,
        priority: t.priority,
        startDate: t.startDate || null,
        deadline: t.deadline || null,
        completed: !!t.completed,
        completedAt: t.completedAt || null,
        parentId: t.parentId || null,
        level: t.level || 0,
        notes: t.notes || ''
      }))
    };
  }

  // 2. 获取任务层级树
  async getTaskTree(options = {}) {
    const { activeOnly = true, scopeId = null } = options;
    const { data: allTasks, online } = await this._invoke(
      activeOnly ? 'tasks:getActive' : 'tasks:getAll',
      (store) => (activeOnly ? store.getActive() : store.getAll())
    );

    const taskMap = new Map();
    const childrenMap = new Map();

    for (const t of allTasks) {
      taskMap.set(t.id, {
        id: t.id,
        content: t.content,
        priority: t.priority,
        startDate: t.startDate || null,
        deadline: t.deadline || null,
        completed: !!t.completed,
        parentId: t.parentId || null,
        level: t.level || 0,
        notes: t.notes || '',
        children: []
      });
      if (t.parentId) {
        if (!childrenMap.has(t.parentId)) childrenMap.set(t.parentId, []);
        childrenMap.get(t.parentId).push(t.id);
      }
    }

    function buildNode(id) {
      const node = taskMap.get(id);
      if (!node) return null;
      const childIds = childrenMap.get(id) || [];
      node.children = childIds.map(buildNode).filter(Boolean);
      return node;
    }

    let roots = [];
    if (scopeId) {
      const rootNode = buildNode(scopeId);
      if (rootNode) roots = [rootNode];
    } else {
      roots = allTasks
        .filter(t => !t.parentId)
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(t => buildNode(t.id))
        .filter(Boolean);
    }

    return {
      onlineMode: online,
      tree: roots
    };
  }

  // 3. 创建单个任务
  async createTask(input) {
    if (!input || !input.content || !input.content.trim()) {
      throw new Error('Task content is required.');
    }
    const clean = {
      content: String(input.content).trim(),
      parentId: input.parentId || undefined,
      priority: ['p0', 'p1', 'p2'].includes(input.priority) ? input.priority : 'p1',
      startDate: input.startDate || undefined,
      deadline: input.deadline || undefined,
      notes: input.notes || undefined
    };

    const { data: created, online } = await this._invoke('tasks:create', (store) => store.createTask(clean), clean);
    return {
      success: true,
      onlineMode: online,
      task: created
    };
  }

  // 4. 批量创建任务
  async batchCreateTasks(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('Tasks array is required.');
    }
    const cleanList = tasks.map(t => ({
      content: String(t.content || '').trim(),
      parentId: t.parentId || undefined,
      priority: ['p0', 'p1', 'p2'].includes(t.priority) ? t.priority : 'p1',
      startDate: t.startDate || undefined,
      deadline: t.deadline || undefined,
      notes: t.notes || undefined
    })).filter(t => t.content);

    const { data: createdList, online } = await this._invoke(
      'tasks:batchCreate',
      (store) => store.batchCreateTasks(cleanList),
      cleanList
    );
    return {
      success: true,
      count: createdList.length,
      onlineMode: online,
      tasks: createdList
    };
  }

  // 5. 更新任务
  async updateTask(id, updates) {
    if (!id) throw new Error('Task ID is required.');
    const { data: updated, online } = await this._invoke(
      'tasks:update',
      (store) => store.updateTask(id, updates),
      { id, updates }
    );
    return {
      success: true,
      onlineMode: online,
      task: updated
    };
  }

  // 6. 完成/取消完成任务
  async completeTask(id, completed = true) {
    if (!id) throw new Error('Task ID is required.');
    const method = completed ? 'tasks:complete' : 'tasks:uncomplete';
    const { data: res, online } = await this._invoke(
      method,
      (store) => (completed ? store.completeTask(id) : store.uncompleteTask(id)),
      { id }
    );
    const mainTask = Array.isArray(res) ? (res.find(t => t.id === id) || res[0]) : res;
    return {
      success: true,
      onlineMode: online,
      task: mainTask,
      affected: Array.isArray(res) ? res : [res]
    };
  }

  // 7. 删除任务
  async deleteTask(id) {
    if (!id) throw new Error('Task ID is required.');
    const { data: res, online } = await this._invoke('tasks:delete', (store) => store.deleteTask(id), { id });
    return {
      success: true,
      onlineMode: online,
      deletedId: id
    };
  }

  // 8. 获取截止日期分桶统计
  async getDeadlineBuckets() {
    const { data: allTasks, online } = await this._invoke('tasks:getAll', (store) => store.getAll());
    const payload = DeadlineBuckets.buildPayload(allTasks, { mode: 'full' });
    const todaySection = (payload.sections || []).find(s => s.key === 'today');
    const tomorrowSection = (payload.sections || []).find(s => s.key === 'tomorrow');
    const overdueSection = (payload.sections || []).find(s => s.key === 'overdue');
    return {
      onlineMode: online,
      todayStr: payload.todayStr,
      tomorrowStr: payload.tomorrowStr,
      overdueCount: payload.overdueTotal || 0,
      todayCount: todaySection ? todaySection.rows.length : 0,
      tomorrowCount: tomorrowSection ? tomorrowSection.rows.length : 0,
      today: todaySection ? todaySection.rows : [],
      tomorrow: tomorrowSection ? tomorrowSection.rows : [],
      overdue: overdueSection ? overdueSection.rows : []
    };
  }

  // 9. 获取甘特图数据
  async getGanttData() {
    const { data: gantt, online } = await this._invoke('gantt:data', (store) => store.getGanttData());
    return {
      onlineMode: online,
      minDate: gantt.minDate,
      maxDate: gantt.maxDate,
      totalCount: gantt.tasks ? gantt.tasks.length : 0,
      tasks: (gantt.tasks || []).map(t => ({
        id: t.id,
        content: t.content,
        startDate: t.startDate,
        deadline: t.deadline,
        level: t.level,
        progress: t.progress,
        completed: t.completed,
        priority: t.priority
      }))
    };
  }

  // 10. 获取或生成周报
  async getWeeklyReport(weekId = null, generateIfMissing = true) {
    let targetWeek = weekId;
    if (!targetWeek) {
      const { data: curWeek } = await this._invoke('reports:currentWeekId', (store) => store.getWeekId(new Date()));
      targetWeek = curWeek;
    }

    let { data: report, online } = await this._invoke(
      'reports:get',
      (store) => store.getWeeklyReport(targetWeek),
      { weekId: targetWeek }
    );

    if (!report && generateIfMissing) {
      const genRes = await this._invoke(
        'reports:generate',
        (store) => store.generateWeeklyReport(targetWeek),
        { weekId: targetWeek }
      );
      report = genRes.data;
    }

    return {
      onlineMode: online,
      weekId: targetWeek,
      report: report || null
    };
  }

  // 11. 随手记便签管理
  async manageNotes(params = {}) {
    const { action = 'list', id, content, pinned } = params;
    if (action === 'list') {
      const { data: notes, online } = await this._invoke('notes:list', (store) => store.getNotes());
      return { onlineMode: online, notes };
    }
    if (action === 'create') {
      if (!content || !content.trim()) throw new Error('Note content is required.');
      const { data: created, online } = await this._invoke('notes:create', (store) => store.createNote({ content, pinned }), { content, pinned });
      return { success: true, onlineMode: online, note: created };
    }
    if (action === 'update') {
      if (!id) throw new Error('Note ID is required.');
      const updates = {};
      if (content !== undefined) updates.content = content;
      if (pinned !== undefined) updates.pinned = !!pinned;
      const { data: updated, online } = await this._invoke('notes:update', (store) => store.updateNote(id, updates), { id, updates });
      return { success: true, onlineMode: online, note: updated };
    }
    if (action === 'delete') {
      if (!id) throw new Error('Note ID is required.');
      const { data: deleted, online } = await this._invoke('notes:delete', (store) => store.deleteNote(id), { id });
      return { success: true, onlineMode: online, deletedId: id };
    }
    throw new Error(`Unsupported note action: ${action}`);
  }
}

module.exports = DataBridge;
