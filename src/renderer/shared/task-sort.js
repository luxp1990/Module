// Module — 任务树排序/邻接表共享（主窗 + widget 单源）
(function () {
  function buildChildrenMap(tasks, { activeOnly = true } = {}) {
    const childrenMap = new Map();
    const taskMap = new Map();
    for (const t of tasks) {
      taskMap.set(t.id, t);
    }
    for (const t of tasks) {
      if (activeOnly && t.completed) continue;
      if (!t.parentId) continue;
      if (!childrenMap.has(t.parentId)) childrenMap.set(t.parentId, []);
      childrenMap.get(t.parentId).push(t);
    }
    for (const arr of childrenMap.values()) {
      arr.sort((a, b) => (a.order || 0) - (b.order || 0));
    }
    return { childrenMap, taskMap };
  }

  function toDeadlineTs(iso) {
    if (!iso) return Infinity;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d, 23, 59, 59).getTime();
    }
    const n = new Date(iso).getTime();
    return Number.isFinite(n) ? n : Infinity;
  }

  /**
   * DFS 层级序（截止日期相同时的次排序键）
   * @param {object[]} tasks
   * @param {{ collapsed?: Set, includeCompleted?: boolean }} opts
   *   collapsed: 若传入，折叠节点不展开子树计入序（截止日期视图传空/不传以全树排序）
   */
  function buildHierarchyOrder(tasks, { collapsed = null, includeCompleted = false } = {}) {
    const { childrenMap } = buildChildrenMap(tasks, { activeOnly: !includeCompleted });
    const order = new Map();
    let idx = 0;
    const tops = tasks
      .filter(t => !t.parentId && (includeCompleted || !t.completed))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const walk = (t) => {
      order.set(t.id, idx++);
      if (collapsed && collapsed.has(t.id)) return;
      for (const k of childrenMap.get(t.id) || []) walk(k);
    };
    for (const t of tops) walk(t);
    return order;
  }

  function unifiedDeadlineSort(a, b, hierarchyOrder) {
    const d = toDeadlineTs(a.deadline) - toDeadlineTs(b.deadline);
    if (d !== 0) return d;
    const ha = hierarchyOrder.has(a.id) ? hierarchyOrder.get(a.id) : Infinity;
    const hb = hierarchyOrder.has(b.id) ? hierarchyOrder.get(b.id) : Infinity;
    return ha - hb;
  }

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.TaskSort = {
    buildChildrenMap,
    toDeadlineTs,
    buildHierarchyOrder,
    unifiedDeadlineSort
  };
})();
