// Module — 控制器：拖拽引擎 (Controller)
(function() {

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

        const rect = row.getBoundingClientRect();
        const ratio = (e.clientY - rect.top) / rect.height;
        const state = this._state.state;
        const targetId = row.dataset.id;
        const Tc = window.ModuleApp.TaskController;
        // 禁止读 DOM data-level：morphdom 增量后可能过期；一律从 parentId 链重算
        const targetTask = state.tasks.find(x => x.id === targetId);
        const targetLevel = Tc?.getTaskLevel?.(targetTask) ?? 0;

        document.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over-child, .drag-over-invalid').forEach(el => {
          el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child', 'drag-over-invalid');
          el.style.removeProperty('--drag-indent');
        });

        let previewLevel = targetLevel;
        let previewParentId = null;
        const scopeIds = state.projectScopeIds || [];
        const isScopedProjectRoot = scopeIds.length > 0 && scopeIds.includes(targetId);

        if (ratio < 0.25) {
          // 项目作用域下：对项目根的「上方同级」会变成全局顶层并消失 → 改为挂到该项目下
          if (isScopedProjectRoot) {
            previewParentId = targetId;
            previewLevel = targetLevel + 1;
            row.classList.add('drag-over-child');
          } else {
            const t = state.tasks.find(x => x.id === targetId);
            previewParentId = t ? t.parentId : null;
            previewLevel = targetLevel;
            row.classList.add('drag-over-top');
          }
        } else if (ratio > 0.75) {
          if (isScopedProjectRoot) {
            previewParentId = targetId;
            previewLevel = targetLevel + 1;
            row.classList.add('drag-over-child');
          } else {
            row.classList.add('drag-over-bottom');
            const offsetX = e.clientX - rect.left;
            const xRatio = Math.max(0, Math.min(1, offsetX / rect.width));
            const indentDelta = Math.round((1 - xRatio * 2) * 2) / 2;
            const finalIndent = Math.max(0, Math.min(targetLevel, targetLevel + indentDelta));
            row.style.setProperty('--drag-indent', finalIndent * 20 + 'px');
            if (finalIndent > targetLevel) {
              previewParentId = targetId;
              previewLevel = targetLevel + 1;
            } else {
              previewLevel = targetLevel - Math.floor(targetLevel - finalIndent);
              const stepUp = Math.floor(targetLevel - finalIndent);
              let cursorTask = state.tasks.find(t => t.id === targetId);
              let guard = 0;
              while (cursorTask && cursorTask.parentId && stepUp - guard > 0 && guard < 10) {
                cursorTask = state.tasks.find(t => t.id === cursorTask.parentId);
                guard++;
              }
              previewParentId = cursorTask ? cursorTask.parentId : null;
            }
          }
        } else {
          previewParentId = targetId;
          previewLevel = targetLevel + 1;
          row.classList.add('drag-over-child');
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
            window.ModuleApp.Toast.show('置顶便签与普通便签不能交叉排序', 'warning');
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

        const targetId = targetRow.dataset.id;
        const Tc0 = window.ModuleApp.TaskController;
        const targetTask0 = state.tasks.find(t => t.id === targetId);
        // 与 dragover 一致：层级从数据重算，不信任 data-level
        const targetLevel = Tc0?.getTaskLevel?.(targetTask0) ?? 0;
        const rect = targetRow.getBoundingClientRect();
        const ratio = (e.clientY - rect.top) / rect.height;

        document.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over-child')
          .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-child'));

        if (targetId === this._dragData.id) { this._dragData = null; return; }
        if (this._dragInvalid) {
          window.ModuleApp.Toast.show('不能放到这里（层级超限或会形成环）', 'error');
          this._dragData = null;
          this._dragInvalid = false;
          return;
        }

        let newParentId = null, newLevel = 0;
        const scopeIds = state.projectScopeIds || [];
        const isScopedProjectRoot = scopeIds.length > 0 && scopeIds.includes(targetId);

        if (ratio < 0.25) {
          if (isScopedProjectRoot) {
            // 项目视图里不能把任务拖成与项目根同级（会消失）；改为该项目的子任务
            newParentId = targetId;
            newLevel = targetLevel + 1;
          } else {
            const t = state.tasks.find(t => t.id === targetId);
            newParentId = t ? t.parentId : null;
            newLevel = targetLevel;
          }
        } else if (ratio > 0.75) {
          if (isScopedProjectRoot) {
            newParentId = targetId;
            newLevel = targetLevel + 1;
          } else {
            const offsetX = e.clientX - rect.left;
            const xRatio = Math.max(0, Math.min(1, offsetX / rect.width));
            const finalIndent = Math.max(0, Math.min(targetLevel, targetLevel + Math.round((1 - xRatio * 2) * 2) / 2));
            if (finalIndent > targetLevel) {
              newParentId = targetId;
              newLevel = targetLevel + 1;
            } else {
              // 使用 Math.floor 向下取整，消除 0.5 浮点数引发的幽灵升级
              const stepUp = Math.floor(targetLevel - finalIndent);
              let cursorTask = state.tasks.find(t => t.id === targetId);
              let guard = 0;
              while (cursorTask && cursorTask.parentId && stepUp - guard > 0 && guard < 10) {
                cursorTask = state.tasks.find(t => t.id === cursorTask.parentId);
                guard++;
              }
              newParentId = cursorTask ? cursorTask.parentId : null;
              // 基于整数运算的绝对层级，免疫零点五干扰
              newLevel = targetLevel - stepUp;
            }
          }
        } else {
          newParentId = targetId;
          newLevel = targetLevel + 1;
        }

        // 项目作用域：任何会拖出当前项目的落点一律拒绝（含左缩进升到全局顶层）
        const PS = window.ModuleApp.ProjectScope;
        if (PS && !PS.staysInProjectScope(state.tasks, scopeIds, newParentId)) {
          window.ModuleApp.Toast.show('当前项目视图下不能移出该项目（会变成看不到的顶层任务）', 'warning');
          this._dragData = null; return;
        }

        // 复用 TaskController 的层级校验工具
        const Tc = window.ModuleApp.TaskController;
        const subtreeDepth = Tc.getSubtreeMaxDepth(this._dragData.id);

        const maxLv = window.ModuleApp.Constants.MAX_LEVEL;
        if (newLevel + subtreeDepth > maxLv) {
          window.ModuleApp.Toast.show('任务层级不能超过五级', 'error');
          this._dragData = null; return;
        }
        if (newParentId && newParentId === this._dragData.id) {
          window.ModuleApp.Toast.show('不能将任务设为自己子任务', 'error');
          this._dragData = null; return;
        }

        // 环路检查
        if (newParentId) {
          let cursor = newParentId;
          const visited = new Set();
          while (cursor && !visited.has(cursor)) {
            visited.add(cursor);
            if (cursor === this._dragData.id) {
              window.ModuleApp.Toast.show('不能将任务拖到后代下', 'error');
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
        const targetTask = state.tasks.find(t => t.id === targetId);
        const targetOrder = targetTask ? (targetTask.order || 0) : 0;
        let newOrder = 0;

        if (siblings.length !== 0) {
          if (ratio < 0.25) {
            const idx = siblings.findIndex(s => s.id === targetId);
            newOrder = idx <= 0 ? (siblings[0].order || 0) - 0.5 : (((siblings[idx - 1].order || 0) + targetOrder) / 2);
          } else if (ratio > 0.75) {
            const idx = siblings.findIndex(s => s.id === targetId);
            newOrder = (idx === -1 || idx >= siblings.length - 1)
              ? ((siblings[siblings.length - 1].order || 0) + 1)
              : ((targetOrder + (siblings[idx + 1].order || 0)) / 2);
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
          window.ModuleApp.Toast.show('已调整层级', 'success');
        } catch (err) {
          window.ModuleApp.Toast.show('调整失败：' + err.message, 'error');
        } finally {
          this._dragData = null;
        }
      });
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.DragController = DragController;
})();
