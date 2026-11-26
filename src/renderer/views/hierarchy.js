// Module — 视图：层级视图（childrenMap + morphdom 增量）
(function() {
  const HierarchyView = {
    _container: null,
    _tasks: [],
    _collapsed: new Set(),
    _childrenMap: new Map(),

    mount(container) {
      this._container = container;
    },

    unmount() {
      this._container = null;
    },

    render(state, actionType) {
      const container = this._container || document.getElementById('viewContainer');
      if (!container) return;

      this._tasks = state.tasks || [];
      const PS = window.ModuleApp.ProjectScope;
      if (PS) {
        this._tasks = PS.filterTasksByProjectScope(this._tasks, state.projectScopeIds);
      }
      this._collapsed = state.collapsed || new Set();
      const Sort = window.ModuleApp.TaskSort;
      this._childrenMap = Sort
        ? Sort.buildChildrenMap(this._tasks, { activeOnly: true }).childrenMap
        : new Map();

      const search = (state.search || '').trim().toLowerCase();

      let topLevel = this._tasks
        .filter(t => !t.completed && !t.parentId)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

      let matchedIds = null;

      if (search) {
        matchedIds = new Set();
        const taskMap = new Map(this._tasks.map(t => [t.id, t]));

        const visit = (id) => {
          const t = taskMap.get(id);
          if (!t) return false;
          const selfMatch = _taskMatchesSearch(t, search);
          const kids = this._childrenMap.get(id) || [];
          let anyKidMatched = false;
          for (const k of kids) { if (visit(k.id)) anyKidMatched = true; }
          if (selfMatch || anyKidMatched) { matchedIds.add(id); return true; }
          return false;
        };
        for (const t of topLevel) visit(t.id);
        topLevel = topLevel.filter(t => matchedIds.has(t.id));
      }

      if (topLevel.length === 0) {
        const scoped = (state.projectScopeIds || []).length > 0;
        const emptyHtml = `
          <div class="empty-state">
            <div class="empty-state-icon">${search ? '🔍' : '📋'}</div>
            <div class="empty-state-title">${search ? '没有匹配的任务' : (scoped ? '该项目下暂无任务' : '还没有主任务')}</div>
            <div class="empty-state-hint">${search ? '试试别的关键词，或清空搜索框' : (scoped ? '点右上角「+ 添加」或在底部输入在本项目下新建' : '点右上角「+ 添加」或在底部输入内容回车创建')}</div>
          </div>`;
        if (window.ModuleApp._renderRoot) window.ModuleApp._renderRoot(container, emptyHtml);
        else container.innerHTML = emptyHtml;
        return;
      }

      const html = `<div class="task-tree">${topLevel.map(t => _renderGroup(t, 0, search, matchedIds)).join('')}</div>`;

      if (window.ModuleApp._renderRoot) {
        window.ModuleApp._renderRoot(container, html, { morph: actionType !== 'REPLACE_FORCE' });
      } else {
        container.innerHTML = html;
      }

    }
  };

  function _renderGroup(task, level, searchQuery, matchedIds) {
    return `
      <div class="task-group" data-id="${task.id}">
        ${_renderTaskTree(task, level, searchQuery, matchedIds)}
      </div>`;
  }

  function _renderTaskTree(task, level, searchQuery, matchedIds) {
    const isCollapsed = HierarchyView._collapsed.has(task.id);
    const forceExpand = !!searchQuery;
    let children = HierarchyView._childrenMap.get(task.id) || [];
    if (matchedIds) children = children.filter(t => matchedIds.has(t.id));

    const hasChildren = children.length > 0;
    const isExpanded = forceExpand || !isCollapsed;

    let html = window.ModuleApp.TaskItem.render(task, level, hasChildren, hasChildren && isExpanded, searchQuery);
    if (hasChildren && isExpanded) {
      html += `<div class="task-children">${children.map(c => _renderTaskTree(c, level + 1, searchQuery, matchedIds)).join('')}</div>`;
    }
    return html;
  }

  function _taskMatchesSearch(task, query) {
    if (!query) return true;
    if (!task) return false;
    if ((task.content || '').toLowerCase().includes(query)) return true;
    if ((task.notes || '').toLowerCase().includes(query)) return true;
    return false;
  }

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.HierarchyView = HierarchyView;
})();
