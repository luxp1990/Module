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

      if (tasks.length === 0) {
        this._container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">✅</div>
            <div class="empty-state-title">${(state.projectScopeIds || []).length ? '该项目下还没有完成的任务' : '还没有完成的任务'}</div>
            <div class="empty-state-hint">完成任务后会在这里显示</div>
          </div>`;
        return;
      }

      const html = `<div class="task-tree">${tasks.map(t => `
        <div class="completed-group" data-id="${t.id}">
          <div class="completed-content">${_escapeHtml(t.content)}</div>
          <span class="completed-time">完成于 ${_fmtDate(t.completedAt)}</span>
          <div class="task-actions">
            <button class="task-action-btn" data-uncomplete="${t.id}" title="恢复为未完成">↶</button>
            <button class="task-action-btn delete" data-delete="${t.id}" title="删除">🗑</button>
          </div>
        </div>
      `).join('')}</div>`;

      this._container.innerHTML = html;
      // 事件在 app.js attachActionHandlers 统一处理
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.CompletedView = CompletedView;
})();
