// Module — 控制器：拖拽引擎 (Controller)
(function() {

  function tr(key, fallback, params) {
    const I18n = window.ModuleApp && window.ModuleApp.I18n;
    if (I18n && typeof I18n.t === 'function') {
      if (typeof I18n.hasKey !== 'function' || I18n.hasKey(key)) {
        return I18n.t(key, params);
      }
    }
    let text = fallback || key;
    if (params && typeof text === 'string') {
      text = text.replace(/\{(\w+)\}/g, (m, k) =>
        Object.prototype.hasOwnProperty.call(params, k) && params[k] !== undefined && params[k] !== null
          ? String(params[k])
          : m
      );
    }
    return text;
  }

  const DragController = {

    _state: null,
    _deps: null,    // { loadTasks, loadNotes, render, refreshUndoUI }
    _dragData: null,
    _bound: false,

    init(stateRef, deps) {
      this._state = stateRef;
      this._deps = deps;
      this.attachHandlers();
    },

    _resolveDropTarget(row, clientX, clientY, state) {
      const targetId = row.dataset.id;
      const Tc = window.ModuleApp.TaskController;
      // 禁止读 DOM data-level：morphdom 增量后可能过期；一律从 parentId 链重算
      const targetTask = state.tasks.find(x => x.id === targetId);
      const targetLevel = Tc?.getTaskLevel?.(targetTask) ?? 0;
      const rect = row.getBoundingClientRect();
      const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
      const scopeIds = state.projectScopeIds || [];
      const isScopedProjectRoot = scopeIds.length > 0 && scopeIds.includes(targetId);

      let parentId = null;
      let level = targetLevel;
      let visualClass = 'drag-over-child';
      let indentPx = null;
      let insertMode = 'first-child';
      let afterTaskId = targetId;

      if (ratio < 0.25) {
        // 项目作用域下：对项目根的「上方同级」会变成全局顶层并消失 → 改为挂到该项目下
        if (isScopedProjectRoot) {
          parentId = targetId;
          level = targetLevel + 1;
          visualClass = 'drag-over-child';
          insertMode = 'first-child';
        } else {
          parentId = targetTask ? targetTask.parentId : null;
          level = targetLevel;
          visualClass = 'drag-over-top';
          insertMode = 'before';
        }
      } else if (ratio > 0.75) {
        if (isScopedProjectRoot) {
          parentId = targetId;
          level = targetLevel + 1;
          visualClass = 'drag-over-child';
          insertMode = 'first-child';
        } else {
          const collapsedSet = state.collapsed || state.collapsedIds;
          const isCollapsed = collapsedSet instanceof Set
            ? collapsedSet.has(targetId)
            : (Array.isArray(collapsedSet) ? collapsedSet.includes(targetId) : false);
          const forceExpand = !!(state.search && state.search.trim());
          const hasVisibleChildren = (forceExpand || !isCollapsed) &&
            state.tasks.some(t => t.parentId === targetId && !t.completed);

          if (hasVisibleChildren) {
            // 展开的父任务下方紧邻其第一个子任务：落点应成为其第一个子任务
            parentId = targetId;
            level = targetLevel + 1;
            visualClass = 'drag-over-bottom';
            indentPx = (targetLevel + 1) * 20;
            insertMode = 'first-child';
          } else {
            const offsetX = clientX - rect.left;
            const baseIndentX = targetLevel * 20;
            let finalIndent = targetLevel;
            if (offsetX > baseIndentX + 36) {
              finalIndent = targetLevel + 1;
            } else if (offsetX < baseIndentX - 16 && targetLevel > 0) {
              const stepsLeft = Math.floor((baseIndentX - offsetX + 16) / 20);
              finalIndent = Math.max(0, targetLevel - Math.max(1, stepsLeft));
            }
            visualClass = 'drag-over-bottom';
            indentPx = finalIndent * 20;

            if (finalIndent > targetLevel) {
              parentId = targetId;
              level = targetLevel + 1;
              insertMode = 'first-child';
            } else {
              const stepUp = targetLevel - finalIndent;
              let cursorTask = targetTask;
              let guard = 0;
              while (cursorTask && cursorTask.parentId && guard < stepUp && guard < 10) {
                cursorTask = state.tasks.find(t => t.id === cursorTask.parentId);
                guard++;
              }
              parentId = cursorTask ? cursorTask.parentId : null;
              level = finalIndent;
              insertMode = 'after';
              afterTaskId = cursorTask ? cursorTask.id : targetId;
            }
          }
        }
      } else {
        parentId = targetId;
        level = targetLevel + 1;
        visualClass = 'drag-over-child';
        insertMode = 'first-child';
      }

      return {
        targetId,
        targetTask,
        targetLevel,
        ratio,
        scopeIds,
        isScopedProjectRoot,
        parentId,
        level,
        visualClass,
        indentPx,
        insertMode,
        afterTaskId
      };
    },

    attachHandlers() {
      if (this._bound) return;
      this._bound = true;

      const vc = document.getElementById('viewContainer');
      if (!vc) return;

      vc.addEventListener('dragstart', e => {
        // 防止点击操作按钮、折叠箭头、输入框或便签标记时误触发拖拽
        if (e.target.closest('button, input, select, textarea, .task-actions, .task-toggle, .notes-indicator')) {
          e.preventDefault();
          return;
        }

        const noteRow = e.target.closest('.note-item[draggable="true"]');
        if (noteRow) {
          this._dragData = { id: noteRow.dataset.noteId, type: 'note' };
          this._dragInvalid = false;
          noteRow.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          return;
        }
        const row = e.target.closest('.task-row[draggable="true"]');
        if (!row) return;
        const id = row.dataset.id;
        const level = parseInt(row.dataset.level, 10);
        this._dragData = { id, level, originalLevel: level, type: 'task' };
        this._dragInvalid = false;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
      });

      vc.addEventListener('dragend', e => {
        document.querySelectorAll('.task-row.dragging, .note-item.dragging').forEach(el => el.classList.remove('dragging'));
        document.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over-child, .drag-over-invalid').forEach(el => {
          el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-invalid');
          el.style.removeProperty('--drag-indent');
        });
        this._dragData = null;
        this._dragInvalid = false;
      });

      vc.addEventListener('dragover', e => {
        if (!this._dragData) return;
        e.preventDefault();
        const row = e.target.closest('.task-row[draggable="true"]');
        if (!row) return;

        const state = this._state.state;
        const Tc = window.ModuleApp.TaskController;
        const dropInfo = this._resolveDropTarget(row, e.clientX, e.clientY, state);
        const { targetId, scopeIds, parentId: previewParentId, level: previewLevel, visualClass, indentPx } = dropInfo;

        document.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over-child, .drag-over-invalid').forEach(el => {
          el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-invalid');
          el.style.removeProperty('--drag-indent');
        });

        row.classList.add(visualClass);
        if (indentPx !== null) {
          row.style.setProperty('--drag-indent', indentPx + 'px');
        }

        // 非法落点：超五级 / 拖到自身或后代 / 拖出当前项目作用域 → 红线禁投
        let invalid = false;
        const PS = window.ModuleApp.ProjectScope;
        const maxLv = window.ModuleApp.Constants?.MAX_LEVEL ?? 4;
        const subtreeDepth = Tc?.getSubtreeMaxDepth?.(this._dragData.id) ?? 0;
        if (previewLevel + subtreeDepth > maxLv) invalid = true;
        if (previewParentId === this._dragData.id) invalid = true;
        if (PS && !PS.staysInProjectScope(state.tasks, scopeIds, previewParentId)) invalid = true;
        if (previewParentId) {
          let cursor = previewParentId;
          const visited = new Set();
          while (cursor && !visited.has(cursor)) {
            visited.add(cursor);
            if (cursor === this._dragData.id) { invalid = true; break; }
            const p = state.tasks.find(t => t.id === cursor);
            if (!p) break;
            cursor = p.parentId;
          }
        }
        if (targetId === this._dragData.id) invalid = true;

        if (invalid) {
          row.classList.add('drag-over-invalid');
          e.dataTransfer.dropEffect = 'none';
          this._dragInvalid = true;
        } else {
          e.dataTransfer.dropEffect = 'move';
          this._dragInvalid = false;
        }
      });

      vc.addEventListener('dragleave', e => {
        const row = e.target.closest('.task-row[draggable="true"]');
        if (row) row.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-invalid');
      });

      vc.addEventListener('drop', async e => {
        if (!this._dragData) return;
        e.preventDefault();
        const state = this._state.state;

        // === 便签重排 ===
        if (this._dragData.type === 'note') {
          const noteRow = e.target.closest('.note-item');
          if (!noteRow) { this._dragData = null; return; }
          const targetId = noteRow.dataset.noteId;
          if (this._dragData.id === targetId) { this._dragData = null; return; }

          const sourceNote = state.notes.find(n => n.id === this._dragData.id);
          const targetNote = state.notes.find(n => n.id === targetId);
          if (!sourceNote || !targetNote || sourceNote.pinned !== targetNote.pinned) {
            window.ModuleApp.Toast.show(tr('toast.saveFailed', '置顶便签与普通便签不能交叉排序', { error: '' }), 'warning');
            this._dragData = null; return;
          }

          const groupNotes = state.notes.filter(n => n.pinned === sourceNote.pinned);
          const sourceIdx = groupNotes.findIndex(n => n.id === this._dragData.id);
          const targetIdx = groupNotes.findIndex(n => n.id === targetId);

          const reorderedGroup = [...groupNotes];
          const [moved] = reorderedGroup.splice(sourceIdx, 1);
          let adjustedTargetIdx = targetIdx;
          if (sourceIdx < targetIdx) adjustedTargetIdx--;
          reorderedGroup.splice(adjustedTargetIdx, 0, moved);

          const items = reorderedGroup.map((n, i) => ({ id: n.id, order: i }));
          try {
            await window.api.notes.reorder(items);
            // 跳过 sender 后发起方必须本地刷新（广播只推 widget/对端）
            await this._deps.loadNotes();
            await this._deps.refreshUndoUI();
            this._deps.render();
          } finally {
            this._dragData = null;
          }
          return;
        }

        // === 任务树重排 ===
        // 类型强校验：防止非任务拖拽数据穿透
        if (this._dragData.type !== 'task') { this._dragData = null; return; }
        const targetRow = e.target.closest('.task-row[draggable="true"]');
        if (!targetRow) { this._dragData = null; return; }

        const dropInfo = this._resolveDropTarget(targetRow, e.clientX, e.clientY, state);
        const { targetId, scopeIds, parentId: newParentId, level: newLevel } = dropInfo;

        document.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over-child')
          .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child'));

        if (targetId === this._dragData.id) { this._dragData = null; return; }
        if (this._dragInvalid) {
          window.ModuleApp.Toast.show(tr('hierarchy.maxLevelReached', '不能放到这里（层级超限或会形成环）'), 'error');
          this._dragData = null;
          this._dragInvalid = false;
          return;
        }

        // 项目作用域：任何会拖出当前项目的落点一律拒绝（含左缩进升到全局顶层）
        const PS = window.ModuleApp.ProjectScope;
        if (PS && !PS.staysInProjectScope(state.tasks, scopeIds, newParentId)) {
          window.ModuleApp.Toast.show(tr('hierarchy.maxLevelReached', '当前项目视图下不能移出该项目（会变成看不到的顶层任务）'), 'warning');
          this._dragData = null; return;
        }

        // 复用 TaskController 的层级校验工具
        const Tc = window.ModuleApp.TaskController;
        const subtreeDepth = Tc.getSubtreeMaxDepth(this._dragData.id);

        const maxLv = window.ModuleApp.Constants.MAX_LEVEL;
        if (newLevel + subtreeDepth > maxLv) {
          window.ModuleApp.Toast.show(tr('hierarchy.maxLevelReached', '任务层级不能超过五级'), 'error');
          this._dragData = null; return;
        }
        if (newParentId && newParentId === this._dragData.id) {
          window.ModuleApp.Toast.show(tr('hierarchy.maxLevelReached', '不能将任务设为自己子任务'), 'error');
          this._dragData = null; return;
        }

        // 环路检查
        if (newParentId) {
          let cursor = newParentId;
          const visited = new Set();
          while (cursor && !visited.has(cursor)) {
            visited.add(cursor);
            if (cursor === this._dragData.id) {
              window.ModuleApp.Toast.show(tr('hierarchy.maxLevelReached', '不能将任务拖到后代下'), 'error');
              this._dragData = null; return;
            }
            const p = state.tasks.find(t => t.id === cursor);
            if (!p) break;
            cursor = p.parentId;
          }
        }

        // 计算 newOrder
        const siblings = state.tasks
          .filter(t => t.parentId === newParentId && t.id !== this._dragData.id)
          .sort((a, b) => (a.order || 0) - (b.order || 0));
        let newOrder = 0;

        if (siblings.length !== 0) {
          if (dropInfo.insertMode === 'before') {
            const idx = siblings.findIndex(s => s.id === targetId);
            const refOrder = idx >= 0 ? (siblings[idx].order || 0) : (siblings[0].order || 0);
            newOrder = idx <= 0 ? refOrder - 0.5 : (((siblings[idx - 1].order || 0) + refOrder) / 2);
          } else if (dropInfo.insertMode === 'after') {
            const refId = dropInfo.afterTaskId || targetId;
            const idx = siblings.findIndex(s => s.id === refId);
            const refOrder = idx >= 0 ? (siblings[idx].order || 0) : (siblings[siblings.length - 1].order || 0);
            newOrder = (idx === -1 || idx >= siblings.length - 1)
              ? (refOrder + 1)
              : ((refOrder + (siblings[idx + 1].order || 0)) / 2);
          } else {
            newOrder = (siblings[0].order || 0) - 0.5;
          }
        }

        try {
          await window.api.tasks.reorder([{ id: this._dragData.id, parentId: newParentId, order: newOrder }]);
          await this._deps.loadTasks();

          if (state.view === 'hierarchy') {
            const vc2 = document.getElementById('viewContainer');
            if (vc2) {
              const st = vc2.scrollTop, sl = vc2.scrollLeft;
              vc2.innerHTML = '';
              // REPLACE_FORCE：结构已变，禁止 morph 错配
              window.ModuleApp.HierarchyView.render(this._state.state, 'REPLACE_FORCE');
              vc2.scrollTop = st; vc2.scrollLeft = sl;
            }
          } else {
            this._deps.render();
          }
          await this._deps.refreshUndoUI();
          window.ModuleApp.Toast.show(tr('toast.taskUpdated', '已调整层级'), 'success');
        } catch (err) {
          window.ModuleApp.Toast.show(tr('toast.saveFailed', '调整失败：{error}', { error: err.message }), 'error');
        } finally {
          this._dragData = null;
        }
      });
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.DragController = DragController;
})();
