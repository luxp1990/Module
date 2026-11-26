// 数据存储 — JSON 文件
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 把任意日期字符串/Date 规范化
function normalizeDate(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  let d;
  if (input instanceof Date) {
    d = input;
  } else {
    d = new Date(input);
  }
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const MAX_TASK_LEVEL = 4; // 0=主任务 … 4=四级子任务（共五级，禁止六级）

class DataStore {
  constructor(dataFile) {
    this.dataFile = dataFile;
    this.data = {
      tasks: [],
      weeklyReports: [],
      deletedWeeklyReports: [], // 墓碑：用户主动删除的周报，禁止 tryAutoWeeklyReport 自动复活
      notes: [],
      // Bug-autoPlan 配置下放修复:autoPlan 之前只存前端 localStorage,
      // 后端 _propagateDatesToAncestors 不查这个标志,导致 UI 关掉后端仍然传播。
      // 下放到 config,后端才能真正遵守用户的开关意图。
      config: { taskRetentionDays: 180, reportRetentionWeeks: 22, autoPlan: false, theme: 'light', projectScopeIds: [], widgetProjectScopeIds: [], lastView: 'hierarchy', dailyReminderEnabled: false, dailyReminderHour: 17, dailyReminderMinute: 0, lastDailyReminderDate: null }
    };
    // Bug-高频同步IO阻塞修复:磁盘写入防抖 300ms,合并连续操作
    this._saveTimeout = null;
    this._saveDelay = 300;
    // Bug-竞态修复:will-quit 强制同步 flush 时,标记销毁状态防止异步重试污染最新数据
    this._isDestroyed = false;
    this._loadError = null;
  }

  _assertReadable() {
    if (this._loadError) throw this._loadError;
  }

  load() {
    if (this._saveTimeout) clearTimeout(this._saveTimeout);
    this._saveTimeout = null;
    const previous = this.data;
    if (fs.existsSync(this.dataFile)) {
      try {
        const raw = fs.readFileSync(this.dataFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || ['tasks', 'notes', 'weeklyReports'].some(key => parsed[key] != null && !Array.isArray(parsed[key]))) {
          throw new Error('数据集合格式无效');
        }
        this.data = parsed;
        if (!this.data.tasks) this.data.tasks = [];
        if (!this.data.weeklyReports) this.data.weeklyReports = [];
        if (!Array.isArray(this.data.deletedWeeklyReports)) this.data.deletedWeeklyReports = [];
        if (!this.data.notes) this.data.notes = [];
        if (!this.data.config) this.data.config = { taskRetentionDays: 180, reportRetentionWeeks: 22, autoPlan: false, theme: 'light', projectScopeIds: [], widgetProjectScopeIds: [], lastView: 'hierarchy', dailyReminderEnabled: false, dailyReminderHour: 17, dailyReminderMinute: 0, lastDailyReminderDate: null };
        if (this.data.config.autoPlan == null) this.data.config.autoPlan = false;
        if (this.data.config.theme !== 'dark' && this.data.config.theme !== 'light') this.data.config.theme = 'light';
        if (!Array.isArray(this.data.config.projectScopeIds)) this.data.config.projectScopeIds = [];
        if (!Array.isArray(this.data.config.widgetProjectScopeIds)) this.data.config.widgetProjectScopeIds = [];
        if (typeof this.data.config.lastView !== 'string') this.data.config.lastView = 'hierarchy';
        if (typeof this.data.config.dailyReminderEnabled !== 'boolean') this.data.config.dailyReminderEnabled = false;
        if (!Number.isFinite(this.data.config.dailyReminderHour)) this.data.config.dailyReminderHour = 17;
        if (!Number.isFinite(this.data.config.dailyReminderMinute)) this.data.config.dailyReminderMinute = 0;
        if (this.data.config.lastDailyReminderDate !== null && typeof this.data.config.lastDailyReminderDate !== 'string') {
          this.data.config.lastDailyReminderDate = null;
        }
        // Bug-原型链安全：加载后立即清洗 __proto__ 污染（防御导入/手动篡改 JSON）
        this._sanitizeProto();
      } catch (e) {
        this.data = previous;
        this._loadError = new Error('数据文件无法读取，已保留原文件且禁止覆盖（' + this.dataFile + '）: ' + e.message);
        this._buildChildrenMap();
        return;

      }
    }
    this._loadError = null;
    // Bug-perf-邻接表：load 完成后即构 childrenMap，避免后续递归 O(N²) filter
    this._buildChildrenMap();
    this.save();
  }

  // 清除 __proto__ 等原型链注入，防御 JSON.parse 携带的污染（审计 1.1）
  _sanitizeProto() {
    for (const t of this.data.tasks) {
      delete t.__proto__;
      delete t.constructor;
      delete t.prototype;
    }
    for (const n of this.data.notes) {
      delete n.__proto__;
      delete n.constructor;
      delete n.prototype;
    }
  }

  // 构建 parentId→children 邻接表（审计 3.1），增/删/拖拽后必须重调
  _buildChildrenMap() {
    this.childrenMap = new Map();
    this.taskMap = new Map(); // O(1) 查找父节点，替代 find() 遍历
    for (const t of this.data.tasks) {
      this.taskMap.set(t.id, t);
      if (t.parentId) {
        if (!this.childrenMap.has(t.parentId)) this.childrenMap.set(t.parentId, []);
        this.childrenMap.get(t.parentId).push(t);
      }
    }
  }

  // 在内存返回前,集中附加基于当前时间的计算字段(daysLeft + urgency + level + childCount)
  // 把所有 compute-* 入口统一收敛到这里，前端不再需要递归 getTaskLevel（审计 3.2）
  _attachComputed(tasks) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return tasks.map(t => {
      const computed = { ...t, daysLeft: null, urgency: 'none', level: null, childCount: 0 };
      // level（审计 3.2：后端一次计算，前端直接读取）
      computed.level = this._computeLevel(t);
      computed.childCount = this.childrenMap && this.childrenMap.has(t.id)
        ? this.childrenMap.get(t.id).length : 0;
      if (t.deadline) {
        const [y, m, d] = t.deadline.split('-').map(Number);
        const dl = new Date(y, m - 1, d);
        // 与前端 daysFromNow 一致：本地日零点差用 round（ceil 在 DST/非整除时会偏一天）
        const diff = Math.round((dl - today) / 86400000);
        computed.daysLeft = diff;
        if (diff < 0) computed.urgency = 'overdue';
        else if (diff === 0) computed.urgency = 'today';
        else if (diff <= 7) computed.urgency = 'due-soon';
        else computed.urgency = 'normal';
      }
      return computed;
    });
  }

  save() {
    this._assertReadable();
    // Bug-同步IO阻塞主线程修复:日常写盘改用异步,只在 will-quit 走同步兜底
    if (this._saveTimeout) clearTimeout(this._saveTimeout);
    // Perf-邻接表自动维护（审计 3.1）：每次 save 前重建 childrenMap，确保所有增删改路径覆盖
    this._buildChildrenMap();
    this._saveTimeout = setTimeout(async () => {
      this._saveTimeout = null;
      await this._saveAsync();
    }, this._saveDelay);
  }

  // 异步写盘(日常调用),主线程零阻塞
  async _saveAsync() {
    this._assertReadable();
    // 互斥锁:防止并发写入导致文件损坏
    if (this._isSaving) {
      // 写入过程中又被请求 → 标记为"还需要再写一次",完成后回头补
      this._pendingResave = true;
      return;
    }
    this._isSaving = true;
    const tmp = this.dataFile + '.tmp.' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);

    try {
      // Bug-3 修复：通过深拷贝投影序列化，防止原始对象上可能的循环引用或临
      // 时附加属性（如函数、DOM 节点引用）导致 JSON.stringify 抛异常或写出脏数据
      const safeData = JSON.parse(JSON.stringify({
        tasks: this.data.tasks,
        weeklyReports: this.data.weeklyReports,
        deletedWeeklyReports: this.data.deletedWeeklyReports,
        notes: this.data.notes,
        config: this.data.config,
      }));
      const dataStr = JSON.stringify(safeData, null, 2);
      await fs.promises.writeFile(tmp, dataStr, 'utf-8');

      // 加入指数退避重试机制，对抗 Windows 杀毒软件的瞬间锁定
      let retries = 3;
      let delay = 100; // 初始等待 100ms
      let renamed = false;

      while (retries > 0 && !renamed) {
        // Bug-竞态修复:will-quit 已触发 flush 强制同步写盘后,本循环必须立即退出,避免覆盖最新数据
        if (this._isDestroyed || this._loadError) return;
        try {
          await fs.promises.rename(tmp, this.dataFile);
          renamed = true;
        } catch (renameErr) {
          // 如果是文件被占用或权限拒绝，说明被杀软锁定，进入重试
          if (renameErr.code === 'EBUSY' || renameErr.code === 'EPERM') {
            retries--;
            if (retries === 0) throw renameErr; // 重试耗尽，抛出异常
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // 下一次等待 200ms, 再下一次 400ms
          } else {
            throw renameErr; // 其他系统错误（如磁盘满），直接抛出
          }
        }
      }
    } catch (e) {
      console.error('[data-store] async save failed:', e.code, e.message);
      // 清理残留的僵尸 tmp 文件
      if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (_) {} }
    } finally {
      this._isSaving = false;
      // 期间又有新数据 → 立刻补一次
      if (this._pendingResave) {
        this._pendingResave = false;
        this.save();
      }
    }
  }

  // 立即同步落盘(用于 load 等必须立即持久化的场景,以及 SIGTERM 前的兜底)
  _forceSaveSync() {
    this._assertReadable();
    const tmp = this.dataFile + '.tmp.' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.dataFile);
    } catch (e) {
      if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (_) {} }
      throw e;
    }
  }

  // 同步等待防抖队列(应用退出前调用,确保内存中的最新数据落盘)
  flush() {
    // Bug-竞态修复:标记销毁后,异步 _saveAsync 的重试循环会立即 return,不会覆盖最新数据
    this._isDestroyed = true;
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }
    // 无论是否有防抖定时器，退出时都强制同步保存一次，防止异步写入被进程退出中断
    try {
      this._forceSaveSync();
    } catch (e) {
      console.error('[data-store] flush sync save failed:', e.message);
    }
  }

  // ==================== Config ====================
  getConfig() {
    this._assertReadable();
    return this.data.config || { taskRetentionDays: 180, reportRetentionWeeks: 22, autoPlan: false, theme: 'light', projectScopeIds: [], widgetProjectScopeIds: [], lastView: 'hierarchy', dailyReminderEnabled: false, dailyReminderHour: 17, dailyReminderMinute: 0, lastDailyReminderDate: null };
  }

  updateConfig(updates) {
    this._assertReadable();
    if (!this.data.config) this.data.config = { taskRetentionDays: 180, reportRetentionWeeks: 22, autoPlan: false, theme: 'light', projectScopeIds: [], widgetProjectScopeIds: [], lastView: 'hierarchy', dailyReminderEnabled: false, dailyReminderHour: 17, dailyReminderMinute: 0, lastDailyReminderDate: null };
    if (updates.taskRetentionDays != null) {
      const v = parseInt(updates.taskRetentionDays, 10);
      if (Number.isFinite(v)) this.data.config.taskRetentionDays = Math.max(30, Math.min(180, v));
    }
    if (updates.reportRetentionWeeks != null) {
      const v = parseInt(updates.reportRetentionWeeks, 10);
      if (Number.isFinite(v)) {
        const max = Math.max(5, Math.min(22, v));
        this.data.config.reportRetentionWeeks = max;
        this.data.weeklyReports = this.data.weeklyReports
          .sort((a, b) => b.weekId.localeCompare(a.weekId))
          .slice(0, max);
      }
    }
    // Bug-autoPlan 配置下放修复:接受前端的布尔开关并持久化
    if (typeof updates.autoPlan === 'boolean') {
      this.data.config.autoPlan = updates.autoPlan;
    }
    if (updates.theme === 'light' || updates.theme === 'dark') {
      this.data.config.theme = updates.theme;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'projectScopeIds')) {
      const arr = Array.isArray(updates.projectScopeIds) ? updates.projectScopeIds : [];
      this.data.config.projectScopeIds = arr.filter(id => typeof id === 'string' && id);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'widgetProjectScopeIds')) {
      const arr = Array.isArray(updates.widgetProjectScopeIds) ? updates.widgetProjectScopeIds : [];
      this.data.config.widgetProjectScopeIds = arr.filter(id => typeof id === 'string' && id);
    }
    if (typeof updates.lastView === 'string' && updates.lastView) {
      const allowed = ['hierarchy', 'deadline', 'gantt', 'completed', 'reports', 'notes'];
      if (allowed.includes(updates.lastView)) this.data.config.lastView = updates.lastView;
    }
    if (typeof updates.dailyReminderEnabled === 'boolean') {
      this.data.config.dailyReminderEnabled = updates.dailyReminderEnabled;
    }
    if (updates.dailyReminderHour != null) {
      const h = parseInt(updates.dailyReminderHour, 10);
      if (Number.isFinite(h)) this.data.config.dailyReminderHour = Math.max(0, Math.min(23, h));
    }
    if (updates.dailyReminderMinute != null) {
      const m = parseInt(updates.dailyReminderMinute, 10);
      if (Number.isFinite(m)) this.data.config.dailyReminderMinute = Math.max(0, Math.min(59, m));
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'lastDailyReminderDate')) {
      const v = updates.lastDailyReminderDate;
      if (v === null || v === '') this.data.config.lastDailyReminderDate = null;
      else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        this.data.config.lastDailyReminderDate = v;
      }
    }
    this.save();
    this.cleanupOldCompleted();
    return this.data.config;
  }

  // ==================== 任务 CRUD ====================
  getAll() {
    this._assertReadable(); return this._attachComputed(this.data.tasks); }
  getActive() {
    this._assertReadable(); return this._attachComputed(this.data.tasks.filter(t => !t.completed)); }
  getCompleted() {
    this._assertReadable(); return this._attachComputed(this.data.tasks.filter(t => t.completed)); }

  _assertActiveParent(parentId) {
    const visited = new Set();
    let currentId = parentId;
    let depth = 0;
    while (currentId) {
      if (visited.has(currentId)) throw new Error('父任务链存在循环');
      visited.add(currentId);
      const parent = this.data.tasks.find(task => task.id === currentId);
      if (!parent) throw new Error('父任务不存在');
      if (parent.completed) throw new Error('请先恢复已完成的父任务');
      if (++depth > MAX_TASK_LEVEL) throw new Error('任务层级不能超过五级');
      currentId = parent.parentId;
    }
  }

  createTask(input) {
    this._assertReadable();
    this._assertActiveParent(input.parentId);
    const content = (input.content || '').trim();
    if (!content) throw new Error('任务内容不能为空');
    const now = new Date().toISOString();
    const parent = input.parentId ? this.data.tasks.find(t => t.id === input.parentId) : null;
    if (parent) {
      const parentLevel = this._computeLevel(parent);
      if (parentLevel >= MAX_TASK_LEVEL) throw new Error('任务层级不能超过五级');
    }
    const task = {
      id: crypto.randomUUID(),
      content,
      deadline: normalizeDate(input.deadline),
      startDate: normalizeDate(input.startDate),
      notes: (input.notes || '').trim(),
      priority: input.priority || null,
      status: input.status || null,
      parentId: input.parentId || null,
      order: input.order ?? this.getNextOrder(input.parentId || null),
      completed: false,
      completedAt: null,
      createdAt: now,
    };
    this.data.tasks.push(task);
    if (task.deadline || task.startDate) this._propagateDatesToAncestors(task.id);
    this.save();
    // Delta Sync：广播/IPC 返回值需带 level/daysLeft/urgency，与 getAll 对齐
    return this._attachComputed([task])[0];
  }

  batchCreateTasks(inputs) {
    this._assertReadable();
    // Validate the whole request before adding any task. Client-supplied IDs are not supported.
    for (const input of inputs) this._assertActiveParent(input.parentId);
    const created = [];
    const affectedParents = new Set(); // [Bug 3] 收集需要重新传播的父节点，避免 O(N) 重复递归
    for (const input of inputs) {
      try {
        const content = (input.content || '').trim();
        if (!content) continue;
        const parent = input.parentId ? this.data.tasks.find(t => t.id === input.parentId) : null;
        if (parent && this._computeLevel(parent) >= MAX_TASK_LEVEL) continue;
        const t = {
          id: crypto.randomUUID(),
          content,
          deadline: normalizeDate(input.deadline),
          startDate: normalizeDate(input.startDate),
          notes: (input.notes || '').trim(),
          priority: input.priority || null,
          status: input.status || null,
          parentId: input.parentId || null,
          order: input.order ?? this.getNextOrder(input.parentId || null),
          completed: false,
          completedAt: null,
          createdAt: new Date().toISOString(),
        };
        this.data.tasks.push(t);
        // [Bug 3] 不再循环内立即传播，改为收集父节点 ID
        if (t.deadline || t.startDate) {
          if (t.parentId) affectedParents.add(t.parentId);
        }
        created.push(t);
      } catch (_) { /* skip invalid */ }
    }
    // [Bug 3] 循环结束后统一一次传播，每个父节点最多算一次
    for (const pid of affectedParents) {
      this._propagateDatesToAncestors(pid);
    }
    if (created.length > 0) this.save();
    return this._attachComputed(created);
  }

  getNextOrder(parentId) {
    const siblings = this.data.tasks.filter(t => t.parentId === parentId);
    if (siblings.length === 0) return 0;
    return Math.max(...siblings.map(t => t.order || 0)) + 1;
  }

  updateTask(id, updates) {
    this._assertReadable();
    const task = this.data.tasks.find(t => t.id === id);
    if (!task) throw new Error('任务不存在');
    const allowed = ['content', 'deadline', 'startDate', 'notes', 'order', 'priority', 'status'];
    for (const k of allowed) {
      if (k in updates) {
        if (k === 'content') {
          const c = (updates.content || '').trim();
          if (!c) throw new Error('任务内容不能为空');
          task.content = c;
        } else if (k === 'order') {
          const o = updates.order;
          if (typeof o !== 'number' || !Number.isFinite(o)) throw new Error('order 必须是有限数值');
          task.order = o;
        } else if (k === 'notes') {
          task.notes = (updates.notes || '').trim();
        } else if (k === 'deadline' || k === 'startDate') {
          task[k] = normalizeDate(updates[k]);
        } else {
          task[k] = updates[k];
        }
      }
    }
    if ('deadline' in updates || 'startDate' in updates) {
      // Bug-假保存修复:用户显式修改了任务的时间,这是"权威输入",
      // 自动规划算法不能反向覆盖。传入 true 让 _propagateDatesToAncestors
      // 跳过本任务本身,只向上传播给父级。
      this._propagateDatesToAncestors(id, true);
    }
    // [Bug 1] importSnapshot 合并时依赖 updatedAt 比较新旧，updateTask 必须补上时间戳
    task.updatedAt = new Date().toISOString();
    this._buildChildrenMap();
    this.save();
    return task;
  }

  deleteTask(id) {
    this._assertReadable();
    const toDelete = new Set([id]);
    const promoteSet = new Set();
    const visitedPromote = new Set();
    const collectCompletedSubtree = (rootId) => {
      if (visitedPromote.has(rootId)) return;
      visitedPromote.add(rootId);
      promoteSet.add(rootId);
      const children = this.data.tasks.filter(t => t.parentId === rootId);
      for (const c of children) collectCompletedSubtree(c.id);
    };
    const visitedWalk = new Set([id]);
    const walk = (pid) => {
      const children = this.data.tasks.filter(t => t.parentId === pid);
      for (const c of children) {
        if (visitedWalk.has(c.id)) continue;
        visitedWalk.add(c.id);
        if (c.completed) collectCompletedSubtree(c.id);
        else { toDelete.add(c.id); walk(c.id); }
      }
    };
    walk(id);
    // Bug-降维打击修复:只有当保留任务的"直接父节点"真的被删除时,才把它提升为顶级
    // Bug-手动删除孤儿标记修复:和 30 天自动清理一样,给孤儿子任务 content 加 [原属:xxx] 前缀
    const deletedTask = this.data.tasks.find(x => x.id === id);
    const parentName = deletedTask ? deletedTask.content : '已删除';
    for (const tid of promoteSet) {
      const t = this.data.tasks.find(x => x.id === tid);
      if (t && toDelete.has(t.parentId)) {
        // 避免重复打标(用户可能多次删除并自动清理)
        if (!/^\[原属:.*\] /.test(t.content || '')) {
          t.content = `[原属: ${parentName}] ` + (t.content || '');
        }
        t.parentId = null;
      }
    }
    this.data.tasks = this.data.tasks.filter(t => !toDelete.has(t.id));
    // Bug-自动规划结构性失明修复:删除完成后,旧父节点需要重新计算日期(子任务可能已全部消失)
    if (deletedTask && deletedTask.parentId) {
      this._propagateDatesToAncestors(deletedTask.parentId);
    }
    this._buildChildrenMap();
    this.save();
    // promotedTasks：升顶后的任务快照，供 Delta 同步 parentId/content
    const promotedTasks = [...promoteSet]
      .filter(pid => !toDelete.has(pid))
      .map(pid => this.data.tasks.find(t => t.id === pid))
      .filter(Boolean)
      .map(t => ({
        id: t.id,
        parentId: t.parentId,
        content: t.content,
        order: t.order,
        completed: t.completed,
        completedAt: t.completedAt,
      }));
    return { deleted: [...toDelete], promoted: [...promoteSet], promotedTasks };
  }

  completeTask(id) {
    this._assertReadable();
    const task = this.data.tasks.find(t => t.id === id);
    if (!task) throw new Error('任务不存在');
    const now = new Date().toISOString();

    // [Phase 0 perf] O(N) 邻接表：一次遍历建立 parent→children 映射，替代每次递归都 filter 全量数组
    const childrenMap = new Map();
    for (const t of this.data.tasks) {
      if (t.parentId) {
        if (!childrenMap.has(t.parentId)) childrenMap.set(t.parentId, []);
        childrenMap.get(t.parentId).push(t);
      }
    }

    const toComplete = [id];
    const findVisited = new Set([id]);

    // 栈迭代 DFS：O(1) 查找子节点，杜绝递归爆栈和 N×depth 次 filter
    const stack = [id];
    while (stack.length > 0) {
      const currId = stack.pop();
      const kids = childrenMap.get(currId);
      if (kids) {
        for (const c of kids) {
          if (!findVisited.has(c.id)) {
            findVisited.add(c.id);
            toComplete.push(c.id);
            stack.push(c.id);
          }
        }
      }
    }

    for (const tid of toComplete) {
      const t = this.data.tasks.find(x => x.id === tid);
      if (t) { t.completed = true; t.completedAt = now; }
    }
    // Bug-自动规划完成盲区修复:完成子任务后必须通知父节点重算日期。
    if (task.parentId) {
      this._propagateDatesToAncestors(task.parentId);
    }
    this.save();
    return this.data.tasks.filter(t => toComplete.includes(t.id));
  }

  uncompleteTask(id) {
    this._assertReadable();
    const task = this.data.tasks.find(t => t.id === id);
    if (!task) throw new Error('任务不存在');
    const before = { ...task };
    try {

    const oldParentId = task.parentId; // 记住老父亲,用于后续时间重算

    // ========== 流派二：自动剥离父级（完美适配版） ==========
    if (oldParentId) {
      const parent = this.data.tasks.find(t => t.id === oldParentId);
      if (parent && parent.completed) {
        // 1. 打上原籍标记
        const prefix = `[原属: ${parent.content}] `;
        // 防御性检查：避免多次剥离导致前缀无限叠加
        if (!task.content.startsWith(prefix)) {
          task.content = prefix + task.content;
        }
        // 2. 断绝父子关系
        task.parentId = null;
        // 3. 防碰撞：获取顶级任务的最新排序值，追加到列表末尾
        task.order = this.getNextOrder(null);
      }
    }
    // =======================================================

    task.completed = false;
    task.completedAt = null;
    task.updatedAt = new Date().toISOString(); // 防合并,补充时间戳

    let current = task;
    const seen = new Set([task.id]);
    let level = 0;
    while (current.parentId) {
      if (seen.has(current.parentId)) throw new Error('任务层级存在循环引用');
      seen.add(current.parentId);
      const parent = this.data.tasks.find(t => t.id === current.parentId);
      if (!parent || parent.completed) throw new Error('请先恢复已完成的祖先任务');
      level++;
      current = parent;
    }
    if (level + this._getSubtreeMaxDepth(id) - 1 > MAX_TASK_LEVEL) throw new Error('恢复后任务层级超过五级');

    // 时间线修复：如果被剥离,让老父亲重算时间边界
    if (task.parentId === null && oldParentId !== null) {
      this._propagateDatesToAncestors(oldParentId);
    }

    this._propagateDatesToAncestors(id);
    this.save();
    return task;
    } catch (error) {
      this.data.tasks[this.data.tasks.indexOf(task)] = before;
      this._buildChildrenMap();
      throw error;
    }
  }

  reorderTasks(items) {
    this._assertReadable();
    // Bug-自动规划结构性失明修复:先收集所有受影响的父节点(原 parentId + 新 parentId)
    // 拖拽完成后统一 propagate,确保旧父和新父的日期都重算
    const affectedParents = new Set();
    for (const item of items) {
      const t = this.data.tasks.find(x => x.id === item.id);
      if (!t) continue;
      if (t.parentId) affectedParents.add(t.parentId);
    }
    for (const item of items) {
      const task = this.data.tasks.find(t => t.id === item.id);
      if (!task) continue;
      if (item.parentId) {
        if (item.parentId === task.id) throw new Error('不能将任务设为自己子任务');
        let cursor = item.parentId;
        const visited = new Set();
        while (cursor && !visited.has(cursor)) {
          visited.add(cursor);
          if (cursor === task.id) throw new Error('不能将任务拖到自己的后代下');
          const p = this.data.tasks.find(t => t.id === cursor);
          if (!p) break;
          cursor = p.parentId;
        }
      }
      if (item.parentId !== task.parentId) {
        const newParent = item.parentId ? this.data.tasks.find(t => t.id === item.parentId) : null;
        if (newParent) {
          const newParentLevel = this._computeLevel(newParent);
          const subtreeMaxDepth = this._getSubtreeMaxDepth(task.id);
          if (newParentLevel + subtreeMaxDepth > MAX_TASK_LEVEL) {
            throw new Error('不能将任务拖入会导致层级超过五级');
          }
        }
      }
      if (item.parentId) affectedParents.add(item.parentId);
      task.parentId = item.parentId;
      task.order = item.order;
    }
    // Bug-111 浮点数精度崩塌修复:每次拖拽用 (A+B)/2 插入,来回拖拽超过 53 次后步长击穿
    // Number.EPSILON,导致 (A+B)/2 === A,两个 order 完全相同,.sort() 不稳定性导致随机乱跳。
    // 修复:在所有移动完成后,对受影响父级的子节点做"整数化拉伸",步长 1000。
    const parentIdsToNormalize = new Set(items.map(item => item.parentId));
    for (const pid of parentIdsToNormalize) {
      const siblings = this.data.tasks.filter(t => t.parentId === pid);
      siblings.sort((a, b) => (a.order || 0) - (b.order || 0));
      siblings.forEach((s, idx) => { s.order = idx * 1000; });
    }
    this.save();
    // 拖拽后让所有受影响的父节点重新计算日期(新父拿到任务要延长、旧父失去任务可能缩短或清空)
    for (const pid of affectedParents) this._propagateDatesToAncestors(pid);
    return true;
  }

  cleanupOldCompleted() {
    this._assertReadable();
    const days = this.data.config?.taskRetentionDays || 180;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const before = this.data.tasks.length;
    const toDeleteIds = new Set(this.data.tasks
      .filter(t => t.completed && t.completedAt && new Date(t.completedAt).getTime() <= cutoff)
      .map(t => t.id)
    );
    const deletedParentNames = {};
    const promotedTasks = [];
    this.data.tasks.forEach(t => {
      if (toDeleteIds.has(t.id)) deletedParentNames[t.id] = t.content;
    });
    this.data.tasks = this.data.tasks.filter(t => !toDeleteIds.has(t.id));
    this.data.tasks.forEach(t => {
      if (t.parentId && toDeleteIds.has(t.parentId)) {
        const marker = '[原属: ' + (deletedParentNames[t.parentId] || '已清理') + '] ';
        // Bug-重复前缀防御（审计 2.1）：多次清理不会叠加 [原属: ...] [原属: ...]
        if (!/^\[原属:.*\] /.test(t.content || '')) {
          t.content = marker + (t.content || '');
        }
        t.parentId = null;
        promotedTasks.push({ ...t });
      }
    });
    const removed = before - this.data.tasks.length;
    if (removed > 0) this.save();
    return { removed, remaining: this.data.tasks.length, deleted: [...toDeleteIds], promotedTasks };
  }

  // ==================== 周报 ====================
  getWeekId(date) {
    const target = new Date(date);
    const d = new Date(Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const isoYear = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const w1Monday = new Date(jan4);
    w1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
    const weekNum = Math.round((d - w1Monday) / (7 * 86400000)) + 1;
    return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
  }

  getWeekRange(weekId) {
    const match = weekId.match(/^(\d{4})-W(\d{2})$/);
    if (!match) throw new Error('周编号格式错误');
    const isoYear = parseInt(match[1]);
    const week = parseInt(match[2]);
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const w1Monday = new Date(jan4);
    w1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
    const monday = new Date(w1Monday);
    monday.setUTCDate(w1Monday.getUTCDate() + (week - 1) * 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return { start: monday, end: sunday };
  }

  listWeeklyReports() {
    this._assertReadable();
    const max = this.data.config?.reportRetentionWeeks || 22;
    return this.data.weeklyReports
      .sort((a, b) => b.weekId.localeCompare(a.weekId))
      .slice(0, max);
  }

  getWeeklyReport(weekId) {
    this._assertReadable();
    return this.data.weeklyReports.find(r => r.weekId === weekId);
  }

  // 墓碑：用户是否主动删除过该周报（删除后禁止后台自动补生成复活）
  isWeeklyReportDeleted(weekId) {
    return Array.isArray(this.data.deletedWeeklyReports) && this.data.deletedWeeklyReports.includes(weekId);
  }

  generateWeeklyReport(weekId) {
    this._assertReadable();
    const { start, end } = this.getWeekRange(weekId);
    // Bug-周报时区倒转修复:getTimezoneOffset 在东半球是负数(UTC+8 返回 -480)
    // 原本 - offset 等于 +时间,导致周一上午完成的记录被算到上周日
    // 修正为 + offset,把 UTC 时间向前"减去"本地偏差,得到正确的本地零时
    const offset = start.getTimezoneOffset() * 60 * 1000;
    const startMs = start.getTime() + offset;
    const endMs = end.getTime() + offset + 24 * 60 * 60 * 1000 - 1;
    const entries = this.data.tasks
      .filter(t => t.completed && t.completedAt)
      .filter(t => {
        const tMs = new Date(t.completedAt).getTime();
        return tMs >= startMs && tMs <= endMs;
      })
      .map(t => {
        const parent = t.parentId ? this.data.tasks.find(p => p.id === t.parentId) : null;
        return {
          taskId: t.id,
          content: t.content,
          completedAt: t.completedAt,
          level: this._computeLevel(t),
          parentContent: parent ? parent.content : null,
        };
      })
      .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
    const existing = this.data.weeklyReports.find(r => r.weekId === weekId);
    const report = {
      weekId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      generatedAt: new Date().toISOString(),
      count: entries.length,
      entries,
      notes: existing ? existing.notes : ''
    };
    this.data.weeklyReports = this.data.weeklyReports.filter(r => r.weekId !== weekId);
    this.data.weeklyReports.push(report);
    // 主动生成/重新生成时，从墓碑列表移除该周（用户显式意图优先于删除标记）
    if (Array.isArray(this.data.deletedWeeklyReports)) {
      this.data.deletedWeeklyReports = this.data.deletedWeeklyReports.filter(id => id !== weekId);
    }
    const max = this.data.config?.reportRetentionWeeks || 22;
    this.data.weeklyReports = this.data.weeklyReports
      .sort((a, b) => b.weekId.localeCompare(a.weekId))
      .slice(0, max);
    this.save();
    return report;
  }

  updateWeeklyReport(weekId, updates) {
    this._assertReadable();
    const report = this.data.weeklyReports.find(r => r.weekId === weekId);
    if (!report) throw new Error('周报不存在');
    if (updates.notes !== undefined) {
      report.notes = (updates.notes || '').trim();
    }
    this.save();
    return report;
  }

  deleteWeeklyReport(weekId) {
    this._assertReadable();
    const idx = this.data.weeklyReports.findIndex(r => r.weekId === weekId);
    if (idx === -1) return false;
    this.data.weeklyReports.splice(idx, 1);
    // 记录墓碑：避免 reports:list 触发的 tryAutoWeeklyReport 立即自动补生成复活
    if (!Array.isArray(this.data.deletedWeeklyReports)) this.data.deletedWeeklyReports = [];
    if (!this.data.deletedWeeklyReports.includes(weekId)) this.data.deletedWeeklyReports.push(weekId);
    this.save();
    return true;
  }

  // ==================== 导入 / 导出 ====================
  exportSnapshot() {
    this._assertReadable();
    return structuredClone(this.data);
  }

  importSnapshot(snapshot, mode = 'replace') {
    this._assertReadable();
    if (!snapshot || typeof snapshot !== 'object') throw new Error('快照格式无效');
    if (!Array.isArray(snapshot.tasks)) snapshot.tasks = [];
    if (!Array.isArray(snapshot.weeklyReports)) snapshot.weeklyReports = [];
    if (!Array.isArray(snapshot.notes)) snapshot.notes = [];

    // Bug-数据导入清洗：防止从外部导入脏数据造成 XSS
    const allowedColorTokens = ['default', 'yellow', 'green', 'pink', 'blue'];
    for (const n of snapshot.notes) {
      if (!n || typeof n !== 'object' || typeof n.id !== 'string') throw new Error('快照含无效便签');
      const rawColor = String(n.color || '');
      n.color = allowedColorTokens.includes(rawColor)
        ? rawColor
        : (rawColor.match(/^#[0-9a-fA-F]{6}$/) ? rawColor : 'default');
      // 确保必填字段存在
      if (typeof n.content !== 'string') n.content = '';
      if (typeof n.pinned !== 'boolean') n.pinned = false;
      if (typeof n.order !== 'number') n.order = 0;
      if (!n.id) n.id = 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      if (!n.createdAt) n.createdAt = new Date().toISOString();
      if (!n.updatedAt) n.updatedAt = n.createdAt;
    }

    for (const t of snapshot.tasks) {
      if (!t || typeof t !== 'object' || typeof t.id !== 'string') throw new Error('快照含无效任务');
      if (t.parentId && t.parentId === t.id) throw new Error(`任务 ${t.id} 的 parentId 指向自身`);
    }
    {
      const idSet = new Set(snapshot.tasks.map(t => t.id));
      for (const t of snapshot.tasks) {
        if (t.parentId && !idSet.has(t.parentId)) throw new Error(`任务 ${t.id} 的 parentId(${t.parentId}) 指向不存在的任务`);
      }
      const detectCycle = (rootId) => {
        const visited = new Set();
        let cur = rootId;
        while (cur) {
          if (visited.has(cur)) return true;
          visited.add(cur);
          const next = snapshot.tasks.find(x => x.id === cur);
          if (!next) break;
          cur = next.parentId;
        }
        return false;
      };
      for (const t of snapshot.tasks) {
        if (t.parentId && detectCycle(t.id)) throw new Error(`检测到 parentId 循环引用,涉及任务 ${t.id}`);
      }
    }

    if (mode === 'replace') {
      // Bug-数据导入清洗：防止从外部导入脏数据造成 XSS
      if (Array.isArray(snapshot.notes)) {
        const allowedColorTokens = ['default', 'yellow', 'green', 'pink', 'blue'];
        for (const n of snapshot.notes) {
          if (!n || typeof n !== 'object' || typeof n.id !== 'string') throw new Error('快照含无效便签');
          const rawColor = String(n.color || '');
          n.color = allowedColorTokens.includes(rawColor)
            ? rawColor
            : (rawColor.match(/^#[0-9a-fA-F]{6}$/) ? rawColor : 'default');
        }
      }
      this.data = {
        tasks: snapshot.tasks,
        weeklyReports: snapshot.weeklyReports,
        deletedWeeklyReports: Array.isArray(snapshot.deletedWeeklyReports) ? snapshot.deletedWeeklyReports : [],
        notes: snapshot.notes || [],
        config: snapshot.config || this.data.config,
      };
    } else if (mode === 'merge') {
      // Bug-106 时光倒流陷阱修复:旧逻辑用 byId.set(t.id, snapshot) 无条件覆盖,
      // 导致半个月前的备份覆盖掉今天刚改的任务,用户毫无察觉。
      // 修复原则:当前数据为尊,只补充缺失项;若 id 冲突,比较 updatedAt,保留较新的。
      const taskTime = (t) => Math.max(
        new Date(t.updatedAt || 0).getTime(),
        new Date(t.completedAt || 0).getTime(),
        new Date(t.createdAt || 0).getTime()
      );
      const byId = new Map(this.data.tasks.map(t => [t.id, t]));
      let snapshotNewerCount = 0;
      for (const t of snapshot.tasks) {
        const existing = byId.get(t.id);
        if (!existing) {
          // 当前没有这条任务,直接补充
          byId.set(t.id, t);
        } else if (taskTime(t) > taskTime(existing)) {
          // 备份里的任务更晚更新过,才覆盖当前(避免旧数据污染)
          byId.set(t.id, t);
          snapshotNewerCount++;
        }
        // 否则保留当前更晚的版本,不动
      }
      this.data.tasks = [...byId.values()];
      const noteTime = note => Math.max(0, ...[note.updatedAt, note.createdAt]
        .map(value => Date.parse(value || '')).filter(Number.isFinite));
      const notesById = new Map(this.data.notes.map(note => [note.id, note]));
      for (const note of snapshot.notes) {
        const current = notesById.get(note.id);
        if (!current || noteTime(note) > noteTime(current)) notesById.set(note.id, note);
      }
      this.data.notes = [...notesById.values()];
      // 周报:同款逻辑,旧周报不应该覆盖新的
      const reportTime = (r) => new Date(r.updatedAt || r.generatedAt || 0).getTime();
      const byWeek = new Map(this.data.weeklyReports.map(r => [r.weekId, r]));
      for (const r of snapshot.weeklyReports) {
        const existing = byWeek.get(r.weekId);
        if (!existing) {
          byWeek.set(r.weekId, r);
        } else if (reportTime(r) > reportTime(existing)) {
          byWeek.set(r.weekId, r);
        }
      }
      const max = this.data.config?.reportRetentionWeeks || 22;
      this.data.weeklyReports = [...byWeek.values()]
        .sort((a, b) => b.weekId.localeCompare(a.weekId))
        .slice(0, max);
      // 墓碑并集：合并导入不复活任何一方已删除的周报
      if (Array.isArray(snapshot.deletedWeeklyReports)) {
        const merged = new Set(this.data.deletedWeeklyReports);
        for (const id of snapshot.deletedWeeklyReports) merged.add(id);
        this.data.deletedWeeklyReports = [...merged];
      }
      this.data.weeklyReports = this.data.weeklyReports.filter(report => !this.data.deletedWeeklyReports.includes(report.weekId));
      console.log(`[import merge] 补充 ${snapshot.tasks.length} 条任务;其中 ${snapshotNewerCount} 条覆盖了当前版本`);
    } else {
      throw new Error('未知导入模式: ' + mode);
    }
    this.save();
    return { tasks: this.data.tasks.length, weeklyReports: this.data.weeklyReports.length };
  }

  // ==================== 甘特图 ====================
  getGanttData() {
    this._assertReadable();
    const tasks = this.getActive();
    const sorted = [...tasks].sort((a, b) => (a.order || 0) - (b.order || 0));
    const childrenMap = {};
    for (const t of sorted) {
      const pid = t.parentId || '__root__';
      if (!childrenMap[pid]) childrenMap[pid] = [];
      childrenMap[pid].push(t);
    }
    let dfsIdx = 0;
    const dfsOrder = {};
    const dfsVisited = new Set();
    const walk = (id) => {
      const kids = childrenMap[id] || [];
      for (const k of kids) {
        if (dfsVisited.has(k.id)) continue;
        dfsVisited.add(k.id);
        dfsOrder[k.id] = dfsIdx++;
        walk(k.id);
      }
    };
    walk('__root__');

    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const result = tasks
      .filter(t => t.deadline)
      .map(t => {
        // 先解析 endDate(deadline),以便 startDate 回退时引用
        let endDate;
        const dl = t.deadline;
        if (/^\d{4}-\d{2}-\d{2}$/.test(dl)) {
          const [y, m, d] = dl.split('-').map(Number);
          endDate = new Date(y, m - 1, d);
        } else {
          endDate = new Date(dl);
        }
        let startDate;
        if (t.startDate) {
          const [y, m, d] = t.startDate.split('-').map(Number);
          startDate = new Date(y, m - 1, d);
        } else {
          startDate = new Date(t.createdAt);
          // Bug-甘特图反向穿越修复:若默认 startDate > deadline(补录过期任务时常见),对齐到截止日期
          if (startDate > endDate) {
            startDate = new Date(endDate);
          }
        }
        const level = this._computeLevel(t);
        return {
          id: t.id, content: t.content,
          start: fmt(startDate), end: fmt(endDate),
          parentId: t.parentId, level: level,
          dfsOrder: dfsOrder[t.id] !== undefined ? dfsOrder[t.id] : 99999,
          urgency: t.urgency,
          daysLeft: t.daysLeft,
        };
      });
    result.sort((a, b) => a.dfsOrder - b.dfsOrder);
    return result;
  }

  _computeLevel(task) {
    if (!task || !task.parentId) return 0;
    let level = 0;
    let current = task;
    const visited = new Set();
    while (current.parentId) {
      if (visited.has(current.id)) break;
      visited.add(current.id);
      level++;
      // 优先使用 taskMap O(1) 查找，降级到 find() 做兼容
      current = this.taskMap ? this.taskMap.get(current.parentId) : this.data.tasks.find(t => t.id === current.parentId);
      if (!current) break;
    }
    return level;
  }

  _getSubtreeMaxDepth(taskId) {
    return this._getSubtreeMaxDepthInner(taskId, new Set([taskId]));
  }
  // 子树高度（含自身）：叶子=1。仅计未完成子孙，与前端拖拽可见树一致。
  _getSubtreeMaxDepthInner(taskId, visited) {
    const children = this.data.tasks.filter(t => t.parentId === taskId && !t.completed);
    if (children.length === 0) return 1;
    let max = 1;
    for (const c of children) {
      if (visited.has(c.id)) continue;
      visited.add(c.id);
      const d = this._getSubtreeMaxDepthInner(c.id, visited);
      if (d + 1 > max) max = d + 1;
    }
    return max;
  }

  // ==================== 自动规划(主进程) ====================
  _propagateDatesToAncestors(startId, skipStartId = false) {
    // Bug-autoPlan 配置下放修复:用户关掉自动规划时,后端必须彻底不传播——
    // 母任务时间保持用户最后一次手动设置的状态,不被任何子任务改动反向干扰。
    // 用户的"权威输入"压倒一切,算法只是辅助。
    if (!this.data.config || !this.data.config.autoPlan) return;
    // Bug-日期黑洞修复:叶子节点自己被改日期时,绝不能擦除用户刚填的日期
    // 只有"曾经是父节点、失子后退化为叶子"才需要清空(本次循环到该节点且无子)
    // 这里采取保守策略:无子任务的节点保留自身日期,只爬祖先做向上传播
    // Bug-假保存修复 (skipStartId=true):尊重用户显式修改,跳过当前任务本身,
    // 直接从父节点开始传播——这样当前任务的日期不会被 _getDescendantDateRange 反向覆盖
    let curId = startId;
    if (skipStartId) {
      const startTask = this.data.tasks.find(t => t.id === startId);
      curId = startTask ? startTask.parentId : null;
    }

    const visited = new Set();
    while (curId && !visited.has(curId)) {
      visited.add(curId);
      const curTask = this.data.tasks.find(t => t.id === curId);
      if (!curTask) break;

      const hasChildren = this.data.tasks.some(t => t.parentId === curId);
      if (hasChildren) {
        // Bug-假保存修复 (active 子任务过滤):如果子任务全部已完成,
        // _getDescendantDateRange 会返回 null,反向覆盖会擦除用户刚填的日期;
        // 只在还有活跃子任务时才用子任务的时间边界去约束母任务
        const activeChildren = this.data.tasks.filter(t => t.parentId === curId && !t.completed);
        if (activeChildren.length > 0) {
          const { minStart, maxDeadline } = this._getDescendantDateRange(curId);
          // [Bug 3] 即使有活跃子任务，如果全部没填日期（minStart/maxDeadline 为 null），
          // 也不能把 null 写回母任务——空白子任务绝不能吞噬用户精心设好的母任务日期
          if (minStart && curTask.startDate !== minStart) curTask.startDate = minStart;
          if (maxDeadline && curTask.deadline !== maxDeadline) curTask.deadline = maxDeadline;
        }
      }
      // 叶子节点:不擦除自身日期(用户填的日期要保留),继续爬祖先
      curId = curTask.parentId;
    }
  }
  _getDescendantDateRange(taskId) {
    const result = { minStart: null, maxDeadline: null };
    const visited = new Set([taskId]);
    const walk = (pid) => {
      const children = this.data.tasks.filter(c => c.parentId === pid && !c.completed);
      for (const c of children) {
        if (visited.has(c.id)) continue;
        visited.add(c.id);
        if (c.startDate && (!result.minStart || c.startDate < result.minStart)) result.minStart = c.startDate;
        if (c.deadline && (!result.maxDeadline || c.deadline > result.maxDeadline)) result.maxDeadline = c.deadline;
        walk(c.id);
      }
    };
    walk(taskId);
    return result;
  }

  // ==================== 备忘录 CRUD ====================
  getNotes() {
    this._assertReadable();
    return this.data.notes.slice().sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      if (a.order != null && b.order != null) return a.order - b.order;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  }

  createNote(input) {
    this._assertReadable();
    const now = new Date().toISOString();
    const content = (input.content || '').trim();
    if (!content) throw new Error('便签内容不能为空');
    // Bug-105 排序索引碰撞修复+跨组污染修复:按组隔离计算 maxOrder，仅在同组内找最大值
    const targetGroup = this.data.notes.filter(n => n.pinned === false);
    const maxOrder = targetGroup.length > 0
      ? Math.max(...targetGroup.map(n => n.order || 0))
      : -1;
    const note = {
      id: crypto.randomUUID(),
      content,
      color: input.color || 'default',
      pinned: false,
      order: input.order ?? (maxOrder + 1),
      createdAt: now,
      updatedAt: now,
    };
    this.data.notes.push(note);
    this.save();
    return note;
  }

  updateNote(id, updates) {
    this._assertReadable();
    const note = this.data.notes.find(n => n.id === id);
    if (!note) throw new Error('备忘录不存在');
    const allowed = ['content', 'color', 'pinned'];
    const allowedColorTokens = ['default', 'yellow', 'green', 'pink', 'blue'];
    for (const k of allowed) {
      if (updates[k] !== undefined) {
        if (k === 'content') {
          note[k] = (updates[k] || '').trim();
        } else if (k === 'color') {
          // Bug-安全防线强化：更新便签颜色时严格校验，防止样式与脚本注入
          const rawColor = String(updates[k]);
          note[k] = allowedColorTokens.includes(rawColor)
            ? rawColor
            : (rawColor.match(/^#[0-9a-fA-F]{6}$/) ? rawColor : 'default');
        } else {
          note[k] = updates[k];
        }
      }
    }
    note.updatedAt = new Date().toISOString();
    this.save();
    return note;
  }

  deleteNote(id) {
    this._assertReadable();
    const idx = this.data.notes.findIndex(n => n.id === id);
    if (idx === -1) throw new Error('备忘录不存在');
    this.data.notes.splice(idx, 1);
    this.save();
    return true;
  }

  reorderNotes(items) {
    this._assertReadable();
    for (const item of items) {
      const note = this.data.notes.find(n => n.id === item.id);
      if (note) note.order = item.order;
    }
    this.save();
    return true;
  }

}

module.exports = DataStore;
