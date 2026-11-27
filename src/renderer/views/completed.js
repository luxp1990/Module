// Module — 视图：已完成任务
(function() {
  function _escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    if (window.ModuleApp?.I18n?.getLocale?.() === 'en-US') {
      return y + '-' + m + '-' + day;
    }
    return y + '年' + m + '月' + day + '日';
  }

  const CompletedView = {
    _container: null,

    mount(container) {
      this._container = container;
    },

    unmount() {
      this._container = null;
    },

    render(state) {
      if (!this._container) return;
      const PS = window.ModuleApp.ProjectScope;
      const scoped = PS
        ? PS.filterTasksByProjectScope(state.tasks, state.projectScopeIds)
        : state.tasks;
      const tasks = scoped
        .filter(t => t.completed)
        .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

      const I18n = window.ModuleApp?.I18n;
      const isEn = I18n?.getLocale?.() === 'en-US';

      if (tasks.length === 0) {
        const emptyTitle = (state.projectScopeIds || []).length
          ? (I18n?.t('hierarchy.emptyFiltered') || '该项目下还没有完成的任务')
          : (I18n?.t('completed.empty') || '还没有完成的任务');
        const emptyHint = isEn ? 'Completed tasks will appear here' : '完成任务后会在这里显示';
        this._container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">✅</div>
            <div class="empty-state-title">${emptyTitle}</div>
            <div class="empty-state-hint">${emptyHint}</div>
          </div>`;
        return;
      }

      const uncompleteTitle = I18n?.t('completed.uncomplete') || '恢复为未完成';
      const deleteTitle = I18n?.t('common.delete') || '删除';

      const html = `<div class="task-tree">${tasks.map(t => {
        const timeStr = _fmtDate(t.completedAt);
        const completedText = I18n?.t('completed.completedAt', { time: timeStr }) || `完成于 ${timeStr}`;
        return `
        <div class="completed-group" data-id="${t.id}">
          <div class="completed-content">${_escapeHtml(t.content)}</div>
          <span class="completed-time">${completedText}</span>
          <div class="task-actions">
            <button class="task-action-btn" data-uncomplete="${t.id}" title="${uncompleteTitle}">↶</button>
            <button class="task-action-btn delete" data-delete="${t.id}" title="${deleteTitle}">🗑</button>
          </div>
        </div>`;
      }).join('')}</div>`;

      this._container.innerHTML = html;
      // 事件在 app.js attachActionHandlers 统一处理
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.CompletedView = CompletedView;
})();
