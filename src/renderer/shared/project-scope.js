// Module — 主任务作用域过滤（项目视图）
// 约定：projectScopeIds 空数组 = 全部；长度≥1 = 这些顶层根及其子孙并集
(function () {
  function _asIds(scopeIds) {
    if (!Array.isArray(scopeIds) || scopeIds.length === 0) return [];
    return scopeIds.filter(id => typeof id === 'string' && id);
  }

  /** 未完成的顶层主任务（项目下拉候选） */
  function listProjectRoots(tasks) {
    return (tasks || [])
      .filter(t => t && !t.parentId && !t.completed)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /** 可见 id 集合；scope 为空则返回 null（表示不过滤） */
  function visibleIdSet(tasks, scopeIds) {
    const ids = _asIds(scopeIds);
    if (ids.length === 0) return null;
    const list = tasks || [];
    const children = new Map();
    for (const t of list) {
      if (!t.parentId) continue;
      let arr = children.get(t.parentId);
      if (!arr) { arr = []; children.set(t.parentId, arr); }
      arr.push(t.id);
    }
    const visible = new Set();
    const stack = ids.slice();
    while (stack.length) {
      const id = stack.pop();
      if (visible.has(id)) continue;
      visible.add(id);
      const kids = children.get(id);
      if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    return visible;
  }

  function filterTasksByProjectScope(tasks, scopeIds) {
    const vis = visibleIdSet(tasks, scopeIds);
    if (!vis) return tasks || [];
    return (tasks || []).filter(t => vis.has(t.id));
  }

  /** 去掉已删除 / 已完成顶层的无效 scope id；全无效则 [] */
  function scrubScopeIds(tasks, scopeIds) {
    const ids = _asIds(scopeIds);
    if (ids.length === 0) return [];
    const byId = new Map((tasks || []).map(t => [t.id, t]));
    const next = [];
    for (const id of ids) {
      const t = byId.get(id);
      if (!t) continue;
      // 仅保留仍存在的节点；若是顶层且已完成，踢掉（与下拉策略一致）
      if (!t.parentId && t.completed) continue;
      next.push(id);
    }
    return next;
  }

  /**
   * 新建默认父级（M2 / §3）
   * - 全部：null（顶层），除非调用方另有高亮逻辑
   * - 单项目：无高亮 → 该根；有高亮且在子树内 → 由调用方用高亮
   * 返回 { parentId, isScoped }
   */
  function defaultCreateParentId(state) {
    const ids = _asIds(state && state.projectScopeIds);
    if (ids.length !== 1) return { parentId: null, isScoped: false };
    return { parentId: ids[0], isScoped: true };
  }

  function isTaskInScope(tasks, scopeIds, taskId) {
    if (!taskId) return false;
    const vis = visibleIdSet(tasks, scopeIds);
    if (!vis) return true;
    return vis.has(taskId);
  }

  /** 新 parent 是否仍落在项目作用域内（空 scope = 始终 true） */
  function staysInProjectScope(tasks, scopeIds, newParentId) {
    const ids = _asIds(scopeIds);
    if (ids.length === 0) return true;
    // 升成全局顶层 = 离开所有项目作用域
    if (newParentId == null) return false;
    // 直接挂到某个项目根下
    if (ids.includes(newParentId)) return true;
    const vis = visibleIdSet(tasks, ids);
    return !!(vis && vis.has(newParentId));
  }

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.ProjectScope = {
    listProjectRoots,
    visibleIdSet,
    filterTasksByProjectScope,
    scrubScopeIds,
    defaultCreateParentId,
    isTaskInScope,
    staysInProjectScope,
  };
})();
