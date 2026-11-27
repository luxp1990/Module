// Module — 视图：截止日期视图（排序逻辑走 TaskSort 单源）
(function() {
  const DeadlineView = {
    _container: null,

    mount(container) {
      this._container = container;
    },

    unmount() {
      this._container = null;
    },

    render(state) {
      if (!this._container) return;

      const U = window.ModuleApp.Utils;
      const Sort = window.ModuleApp.TaskSort;
      const escapeHtml = (s) => (U ? U.escapeHtml(s) : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'));
      const fmtDateShort = (iso) => U ? U.fmtDateShort(iso) : iso;
      const daysFromNow = (iso) => U ? U.daysFromNow(iso) : null;
      const deadlineClass = (iso) => U ? U.deadlineClass(iso) : '';
      const deadlineLabel = (iso) => U ? U.deadlineLabel(iso) : '';

      // 全树 DFS 序（不因折叠截断），与 widget 一致；先按项目作用域过滤
      const PS = window.ModuleApp.ProjectScope;
      const scopedTasks = PS
        ? PS.filterTasksByProjectScope(state.tasks, state.projectScopeIds)
        : state.tasks;

      const hierarchyOrder = Sort
        ? Sort.buildHierarchyOrder(scopedTasks, { collapsed: null, includeCompleted: false })
        : new Map();

      const tasks = scopedTasks
        .filter(t => !t.completed && t.deadline)
        .sort((a, b) => Sort
          ? Sort.unifiedDeadlineSort(a, b, hierarchyOrder)
          : 0);

      if (tasks.length === 0) {
        const I18n = window.ModuleApp?.I18n;
        const emptyTitle = (state.projectScopeIds || []).length
          ? (I18n?.t('hierarchy.emptyFiltered') || '该项目下没有带截止日期的任务')
          : (I18n?.t('deadline.empty') || '没有待办任务');
        const emptyHint = I18n?.t('hierarchy.empty') || '点右上角「+ 添加」或在底部输入任务开始';
        this._container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📅</div>
            <div class="empty-state-title">${emptyTitle}</div>
            <div class="empty-state-hint">${emptyHint}</div>
          </div>`;
        return;
      }

      const { taskMap } = Sort
        ? Sort.buildChildrenMap(scopedTasks, { activeOnly: false })
        : { taskMap: new Map(scopedTasks.map(t => [t.id, t])) };

      const I18n = window.ModuleApp?.I18n;
      const isEn = I18n?.getLocale?.() === 'en-US';
      const pLabels = {
        p0: I18n?.t('priority.p0Short') || 'P0',
        p1: I18n?.t('priority.p1Short') || 'P1',
        p2: I18n?.t('priority.p2Short') || 'P2',
      };
      const sLabels = {
        todo: I18n?.t('status.todo') || '待办',
        progress: I18n?.t('status.progress') || '进行中',
        blocked: I18n?.t('status.blocked') || '阻塞',
        review: I18n?.t('status.review') || '审核中',
      };
      const notesTitle = isEn ? 'View notes' : '查看备注';
      const editTitle = I18n?.t('common.edit') || '编辑';
      const doneTitle = I18n?.t('common.done') || '完成';
      const delTitle = I18n?.t('common.delete') || '删除';

      const html = `<div class="task-tree">${tasks.map(t => {
        const dClass = deadlineClass(t.deadline);
        const overdueClass = dClass === 'danger' ? 'is-overdue' : (dClass === 'warning' ? 'is-due-soon' : '');
        const dLabel = deadlineLabel(t.deadline);
        const hasNotes = t.notes && t.notes.trim().length > 0;

        const parentChain = [];
        let p = t.parentId ? taskMap.get(t.parentId) : null;
        while (p) {
          parentChain.unshift(p.content);
          p = p.parentId ? taskMap.get(p.parentId) : null;
        }
        const parentText = parentChain.length > 0
          ? `<span style="color:var(--fg-soft);font-size:12px;">↳ ${escapeHtml(parentChain.join(' › '))}</span>`
          : '';

        let deadlineBadge;
        if (!t.deadline) {
          deadlineBadge = `<span class="deadline" style="color:var(--fg-soft);">${I18n?.t('deadline.noDeadline') || '无截止日期'}</span>`;
        } else {
          const days = daysFromNow(t.deadline);
          const lbl = (dClass === 'danger' || dClass === 'warning')
            ? dLabel
            : (I18n?.t('deadline.daysLeft', { days }) || `还有 ${days} 天`);
          deadlineBadge = `<span class="deadline ${dClass}">${lbl} · ${fmtDateShort(t.deadline)}</span>`;
        }

        const priorityBadge = t.priority
          ? `<span class="task-priority-badge ${t.priority}">🔴 ${pLabels[t.priority] || t.priority}</span>`
          : '';
        const statusBadge = t.status
          ? `<span class="task-status-badge ${t.status}">${sLabels[t.status] || t.status}</span>`
          : '';

        return `
          <div class="task-group">
            <div class="task-row level-0 ${overdueClass}" data-id="${t.id}"
                 oncontextmenu="event.preventDefault();showContextMenu('${t.id}',event.clientX,event.clientY)">
              <div class="task-content">
                <span class="task-content-text">${escapeHtml(t.content)}</span>
                ${parentText}
              </div>
              <div class="task-meta">
                ${priorityBadge}
                ${statusBadge}
                ${deadlineBadge}
                ${hasNotes ? `<span class="notes-indicator" data-notes="${t.id}" title="${notesTitle}">📝</span>` : ''}
              </div>
              <div class="task-actions">
                <button class="task-action-btn" data-edit="${t.id}" title="${editTitle}">✎</button>
                <button class="task-action-btn complete" data-complete="${t.id}" title="${doneTitle}">✓</button>
                <button class="task-action-btn delete" data-delete="${t.id}" title="${delTitle}">🗑</button>
              </div>
            </div>
          </div>`;
      }).join('')}</div>`;

      this._container.innerHTML = html;
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.DeadlineView = DeadlineView;
})();
