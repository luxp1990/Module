// Module — 控制器：任务中枢 (Controller)
// 接管所有与任务增删改查、批量操作、快速输入相关的核心业务。
// 依赖 window.ModuleApp.State 单例，生命周期由 app.js init() 启动。
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

  const TaskController = {

    _state: null,
    _deps: null,   // { loadTasks, render, refreshUndoUI, attachDragHandlers, attachNotesHandlers }

    init(stateRef, deps) {
      this._state = stateRef;
      this._deps = deps;
      this.bindQuickInput();
      this.attachActionHandlers();
    },

    // ===== 快速输入栏逻辑 =====
    bindQuickInput() {
      const qInput = document.getElementById('quickInput');
      const qClear = document.getElementById('quickInputClear');
      if (qInput) {
        qInput.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            this.handleQuickInput();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            qInput.value = '';
            this.clearQuickInputExtras();
            this._quickCreateArmedUntil = 0;
            this.clearSelection();
          }
        });
      }
      if (qClear) {
        qClear.addEventListener('click', () => {
          qInput.value = '';
          this.clearQuickInputExtras();
          this.clearSelection();
          qInput.focus();
        });
      }

      // ========== 🚀 修复：绑定快速输入栏的日期选择器 ==========
      const startBtn = document.getElementById('quickInputStartBtn');
      const dlBtn = document.getElementById('quickInputDateBtn');

      if (startBtn) {
        startBtn.addEventListener('click', () => {
          window.ModuleApp.DatePicker.show({
            target: 'quickStart',
            title: tr('modal.startDate', '选择开始日期'),
            value: this._state.state.quickDraft.startDate
          }, (tgt, val) => {
            const draft = this._state.state.quickDraft;
            this._state.patch({ quickDraft: { ...draft, startDate: val } });
            this.updateQuickDateBtns();
          });
        });
      }

      if (dlBtn) {
        dlBtn.addEventListener('click', () => {
          window.ModuleApp.DatePicker.show({
            target: 'quickDeadline',
            title: tr('modal.deadline', '选择截止日期'),
            value: this._state.state.quickDraft.deadline
          }, (tgt, val) => {
            const draft = this._state.state.quickDraft;
            this._state.patch({ quickDraft: { ...draft, deadline: val } });
            this.updateQuickDateBtns();
          });
        });
      }
      // ========================================================
    },

    async handleQuickInput() {
      const qInput = document.getElementById('quickInput');
      const rawContent = qInput.value;
      if (!rawContent.trim()) return;

      if (rawContent.includes('\n')) {
        const lines = rawContent.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length > 1) {
          const created = await this.batchCreateFromLines(lines);
          if (created > 0 && qInput.value === rawContent) qInput.value = '';
          return;
        }
      }

      const content = rawContent.trim();
      const state = this._state.state;
      let _deadline = state.quickDraft.deadline;
      let _startDate = state.quickDraft.startDate;

      if (state.view === 'deadline' && !_deadline) {
        const td = new Date();
        _deadline = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, '0')}-${String(td.getDate()).padStart(2, '0')}`;
        this._state.patch({ quickDraft: { ...state.quickDraft, deadline: _deadline } });
        window.ModuleApp.Toast.show(tr('deadline.dueToday', '已自动将截止日期设为今天'), 'info');
      }

      if (_deadline && !_startDate) {
        const td = new Date();
        const todayStr = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, '0')}-${String(td.getDate()).padStart(2, '0')}`;
        _startDate = (_deadline < todayStr) ? _deadline : todayStr;
      }

      if (_startDate && _deadline && _deadline < _startDate) {
        window.ModuleApp.Toast.show(tr('toast.validationDateRange', '截止日期不能早于开始日期'), 'error');
        return;
      }

      const notesRaw = document.getElementById('quickInputNotes')?.value.trim();
      const notes = notesRaw || null;

      let parentId = null;
      if (state.selectedId) {
        const task = state.tasks.find(t => t.id === state.selectedId);
        if (task) {
          const level = this.getTaskLevel(task);
          const maxLv = window.ModuleApp.Constants.MAX_LEVEL;
          if (level >= maxLv) {
            window.ModuleApp.Toast.show(tr('hierarchy.maxLevelReached', '该任务已到最深层级，无法添加子任务'), 'error');
            return;
          }
          parentId = task.id;
        }
      } else {
        const def = window.ModuleApp.ProjectScope?.defaultCreateParentId(state);
        if (def?.parentId) parentId = def.parentId;
      }

      let order = 0;
      if (parentId) {
        const siblings = state.tasks.filter(t => t.parentId === parentId);
        order = siblings.length > 0 ? Math.max(...siblings.map(s => s.order || 0)) + 1 : 0;
      } else {
        const tops = state.tasks.filter(t => !t.parentId);
        order = tops.length > 0 ? Math.max(...tops.map(s => s.order || 0)) + 1 : 0;
      }

      try {
        const newTask = await window.api.tasks.create({ content, deadline: _deadline, startDate: _startDate, notes, parentId, order });
        qInput.value = '';
        this.clearQuickInputExtras();

        await this._deps.loadTasks();
        if (parentId && state.collapsed.has(parentId)) state.collapsed.delete(parentId);
        await this.applyAutoPlan(newTask.id);
        this._deps.render();
        await this._deps.refreshUndoUI();

        setTimeout(() => {
          const row = document.querySelector(`.task-row[data-id="${newTask.id}"]`);
          if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
        qInput.focus();
        window.ModuleApp.Toast.show(tr('toast.taskCreated', parentId ? '已添加子任务' : '已创建主任务'), 'success');
      } catch (err) {
        window.ModuleApp.Toast.show(tr('toast.saveFailed', '创建失败：{error}', { error: err.message }), 'error');
      }
    },

    clearQuickInputExtras() {
      const s = this._state.state.quickDraft;
      this._state.patch({ quickDraft: { ...s, startDate: null, deadline: null, notes: '', notesExpanded: false } });
      this.updateQuickDateBtns();
      const notesEl = document.getElementById('quickInputNotes');
      const notesBtn = document.getElementById('quickInputNotesBtn');
      if (notesEl) { notesEl.value = ''; notesEl.hidden = true; }
      if (notesBtn) notesBtn.classList.remove('active');
    },

    updateQuickDateBtns() {
      const state = this._state.state;
      const dBtn = document.getElementById('quickInputDateBtn');
      if (dBtn) {
        const dv = state.quickDraft.deadline;
        dBtn.textContent = dv ? '📅 ' + dv : `📅 ${tr('modal.deadline', '截止')}`;
        dBtn.classList.toggle('has-value', !!dv);
      }
      const sBtn = document.getElementById('quickInputStartBtn');
      if (sBtn) {
        const sv = state.quickDraft.startDate;
        sBtn.textContent = sv ? '🚀 ' + sv : `🚀 ${tr('modal.startDate', '开始')}`;
        sBtn.classList.toggle('has-value', !!sv);
      }
    },

    async batchCreateFromLines(lines) {
      const state = this._state.state;
      let parentId = null;
      if (state.selectedId) {
        const task = state.tasks.find(t => t.id === state.selectedId);
        if (!task) {
          const def = window.ModuleApp.ProjectScope?.defaultCreateParentId(state);
          if (def?.parentId) parentId = def.parentId;
        } else if (this.getTaskLevel(task) >= window.ModuleApp.Constants.MAX_LEVEL) {
          window.ModuleApp.Toast.show(tr('hierarchy.maxLevelReached', '该任务已到最深层级，无法添加子任务'), 'error');
          return;
        } else {
          parentId = task.id;
        }
      } else {
        const def = window.ModuleApp.ProjectScope?.defaultCreateParentId(state);
        if (def?.parentId) parentId = def.parentId;
      }
      let order = 0;
      if (parentId) {
        const siblings = state.tasks.filter(t => t.parentId === parentId);
        order = siblings.length > 0 ? Math.max(...siblings.map(s => s.order || 0)) + 1 : 0;
      } else {
        const tops = state.tasks.filter(t => !t.parentId);
        order = tops.length > 0 ? Math.max(...tops.map(s => s.order || 0)) + 1 : 0;
      }

      // 提取用户在快速输入栏配置的日期
      const _deadline = state.quickDraft.deadline || null;
      const _startDate = state.quickDraft.startDate || null;

      let created = 0;
      try {
        const inputs = lines.map((line, i) => ({ content: line, parentId, order: order + i, deadline: _deadline, startDate: _startDate, notes: null }));
        const results = await window.api.tasks.batchCreate(inputs);
        created = results.length;
      } catch (e) {
        window.ModuleApp.Toast.show(tr('toast.saveFailed', '批量创建失败: {error}', { error: e.message || e }), 'error');
        return 0;
      }
      if (created > 0) {
        await this._deps.loadTasks();
        await this.applyAutoPlan(null);
        this._deps.render();
        await this._deps.refreshUndoUI();
      }
      if (created > 0) window.ModuleApp.Toast.show(tr('notes.aiExtractSuccess', '已批量创建 {count} 个任务', { count: created }), 'success');
      return created;
    },

    // ===== 任务核心操作 =====
    async saveTask() {
      const state = this._state.state;
      const content = document.getElementById('taskContent')?.value.trim();
      if (!content) { window.ModuleApp.Toast.show(tr('toast.validationTitleRequired', '任务内容不能为空'), 'error'); return; }

      let deadline = window.ModuleApp.Modal.normalizeDateInput(
        document.getElementById('taskDeadline')?.value || ''
      ) || null;
      let startDate = window.ModuleApp.Modal.normalizeDateInput(
        document.getElementById('taskStartDate')?.value || ''
      ) || null;
      const priority = document.getElementById('taskPriority')?.value || null;
      const status = document.getElementById('taskStatus')?.value || null;
      const notes = document.getElementById('taskNotes')?.value || null;

      const dateOk = (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
      if (!dateOk(startDate) || !dateOk(deadline)) {
        window.ModuleApp.Toast.show(tr('toast.validationDateRange', '日期格式应为 YYYY-MM-DD'), 'error');
        return;
      }

      if (state.view === 'deadline' && !deadline) {
        const td = new Date();
        deadline = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, '0')}-${String(td.getDate()).padStart(2, '0')}`;
        window.ModuleApp.Toast.show(tr('deadline.dueToday', '已自动将截止日期设为今天'), 'info');
      }
      if (deadline && !startDate) {
        const td = new Date();
        const todayStr = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, '0')}-${String(td.getDate()).padStart(2, '0')}`;
        startDate = (deadline < todayStr) ? deadline : todayStr;
      }
      if (startDate && deadline && deadline < startDate) {
        window.ModuleApp.Toast.show(tr('toast.validationDateRange', '截止日期不能早于开始日期'), 'error');
        return;
      }

      try {
        let _editedId = null;
        if (state.modalTask?.mode === 'create') {
          const parentId = state.modalTask.parentId;
          let order = 0;
          if (parentId) {
            const siblings = state.tasks.filter(t => t.parentId === parentId);
            order = siblings.length > 0 ? Math.max(...siblings.map(s => s.order || 0)) + 1 : 0;
          } else {
            const tops = state.tasks.filter(t => !t.parentId);
            order = tops.length > 0 ? Math.max(...tops.map(s => s.order || 0)) + 1 : 0;
          }
          const res = await window.api.tasks.create({ content, deadline, startDate, notes, priority, status, parentId, order });
          _editedId = res.id;
          if (parentId && state.collapsed.has(parentId)) state.collapsed.delete(parentId);
          window.ModuleApp.Toast.show(tr('toast.taskCreated', '任务已创建'), 'success');
        } else {
          _editedId = state.modalTask.id;
          await window.api.tasks.update(_editedId, { content, deadline, startDate, priority, status, notes });
          window.ModuleApp.Toast.show(tr('toast.taskUpdated', '任务已更新'), 'success');
        }

        window.ModuleApp.Modal.closeTaskModal();
        await this._deps.loadTasks();
        await this.applyAutoPlan(_editedId);
        this._deps.render();
        await this._deps.refreshUndoUI();
      } catch (err) {
        window.ModuleApp.Toast.show(tr('toast.saveFailed', '保存失败: {error}', { error: err.message }), 'error');
      }
    },

    async handleComplete(id) {
      const state = this._state.state;
      const task = state.tasks.find(t => t.id === id);
      if (!task) return;
      const subCount = state.tasks.filter(t => t.parentId === id && !t.completed).length;
      const ok = await window.ModuleApp.Modal.confirm({
        title: tr('contextMenu.complete', '完成任务'),
        message: subCount > 0 ? `「${task.content}」下还有 ${subCount} 个未完成子任务。\n主任务完成时将同步完成，确定继续吗?` : `确定完成任务「${task.content}」吗?`
      });
      if (!ok) return;

      try {
        const wasScopeRoot = (state.projectScopeIds || []).includes(id);
        await window.api.tasks.complete(id);
        if (state.selectedId === id || state.multiSelect.has(id)) this.clearSelection();
        await this._deps.loadTasks();
        await this._deps.refreshUndoUI();
        this._deps.render();
        if (wasScopeRoot && (this._state.state.projectScopeIds || []).length === 0) {
          window.ModuleApp.Toast.show(tr('toast.taskCompleted', '项目已完成，已切回全部项目'), 'info');
        } else {
          window.ModuleApp.Toast.show(tr('toast.taskCompleted', '已完成 ✓'), 'success');
        }
      }
      catch (err) { window.ModuleApp.Toast.show(tr('toast.saveFailed', '完成失败: {error}', { error: err.message }), 'error'); }
    },

    async handleDelete(id) {
      const state = this._state.state;
      const task = state.tasks.find(t => t.id === id);
      if (!task) return;
      const subCount = state.tasks.filter(t => t.parentId === id).length;
      const ok = await window.ModuleApp.Modal.confirm({
        title: tr('contextMenu.delete', '删除任务'),
        message: tr('modal.deleteTaskConfirm', subCount > 0 ? `确定删除「${task.content}」及其 ${subCount} 个子任务吗?\n删除后可用 Ctrl+Z 撤回。` : `确定删除「${task.content}」吗?\n删除后可用 Ctrl+Z 撤回。`, { title: task.content })
      });
      if (!ok) return;

      try {
        const scopeBefore = [...(state.projectScopeIds || [])];
        const wasScopeRoot = scopeBefore.includes(id);
        const result = await window.api.tasks.delete(id);
        if (state.selectedId === id || state.multiSelect.has(id)) this.clearSelection();
        await this._deps.loadTasks();
        await this._deps.refreshUndoUI();
        this._deps.render();
        const PS = window.ModuleApp.ProjectScope;
        const promoted = (result && result.promotedTasks) || [];
        const leftScope = scopeBefore.length > 0 && promoted.some(p =>
          !PS?.isTaskInScope?.(this._state.state.tasks, this._state.state.projectScopeIds, p.id)
        );
        if (wasScopeRoot && (this._state.state.projectScopeIds || []).length === 0) {
          window.ModuleApp.Toast.show(tr('toast.deleteSuccess', '项目已删除，已切回全部项目'), 'warning');
        } else if (leftScope) {
          window.ModuleApp.Toast.show(
            tr('toast.deleteSuccess', `已删除；有 ${promoted.length} 个已完成子任务升为顶层，不在当前项目内`),
            'warning'
          );
        } else {
          window.ModuleApp.Toast.show(tr('toast.deleteSuccess', '已删除'), 'warning');
        }
      }
      catch (err) { window.ModuleApp.Toast.show(tr('toast.deleteFailed', '删除失败: {error}', { error: err.message }), 'error'); }
    },

    async handleUncomplete(id) {
      try {
        const state = this._state.state;
        const scopeBefore = [...(state.projectScopeIds || [])];
        // 修复: 不再向上收集已完成父任务(后端流派二会自动剥离)
        await window.api.tasks.batchUncomplete([id]);
        await this._deps.loadTasks();
        if (state.selectedId === id) this.clearSelection();
        const PS = window.ModuleApp.ProjectScope;
        const restored = this._state.state.tasks.find(t => t.id === id);
        const stillScoped = scopeBefore.length === 0
          || (restored && PS?.isTaskInScope?.(this._state.state.tasks, scopeBefore, id));
        if (scopeBefore.length > 0 && restored && !stillScoped) {
          // 剥离成顶层后离开当前项目：切回全部并说明
          if (typeof window.ModuleApp.setProjectScope === 'function') {
            await window.ModuleApp.setProjectScope([]);
          } else {
            this._state.patch({ projectScopeIds: [] });
            try { await window.api.config.update({ projectScopeIds: [] }); } catch (_) {}
            this._deps.render();
          }
          window.ModuleApp.Toast.show(
            tr('toast.taskUncompleted', '已恢复为顶层任务（原父任务仍已完成），已切回全部项目'),
            'info'
          );
        } else {
          this._deps.render();
          window.ModuleApp.Toast.show(tr('toast.taskUncompleted', '已剥离并恢复为进行中'), 'success');
        }
        await this._deps.refreshUndoUI();
      } catch (err) { window.ModuleApp.Toast.show(tr('toast.saveFailed', '恢复失败：{error}', { error: err.message }), 'error'); }
    },

    // ===== 批量操作与上下文路由 =====
    async handleContextAction(action, value, taskId) {
      const state = this._state.state;
      if (!taskId) return;
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;

      if (action === 'edit') {
        this.openEditModal(taskId);
      } else if (action === 'addChild') {
        if (this.getTaskLevel(task) >= window.ModuleApp.Constants.MAX_LEVEL) {
          return window.ModuleApp.Toast.show(tr('hierarchy.maxLevelReached', '任务层级不能超过五级'), 'error');
        }
        this.focusQuickCreate({ parentId: taskId });
      } else if (action === 'complete') {
        const targetIds = state.multiSelect.has(taskId) ? [...state.multiSelect] : [taskId];
        if (targetIds.length > 1) this.handleBatchAction('complete', targetIds);
        else this.handleComplete(taskId);
      } else if (action === 'delete') {
        const targetIds = state.multiSelect.has(taskId) ? [...state.multiSelect] : [taskId];
        if (targetIds.length > 1) this.handleBatchAction('delete', targetIds);
        else this.handleDelete(taskId);
      } else if (action === 'setPriority' || action === 'setStatus') {
        const targetIds = state.multiSelect.has(taskId) ? [...state.multiSelect] : [taskId];
        try {
          if (action === 'setPriority') {
            targetIds.length > 1
              ? await window.api.tasks.batchSetPriority(targetIds, value || null)
              : await window.api.tasks.update(taskId, { priority: value || null });
          } else {
            for (const tId of targetIds) await window.api.tasks.update(tId, { status: value });
          }
          if (targetIds.length > 1) this.clearSelection();
          await this._deps.loadTasks();
          await this._deps.refreshUndoUI();
          this._deps.render();
          window.ModuleApp.Toast.show(tr('toast.taskUpdated', '已更新属性'), 'success');
        } catch (err) {
          window.ModuleApp.Toast.show(tr('toast.saveFailed', '操作失败: {error}', { error: err.message || err }), 'error');
        }
      }
    },

    async handleBatchAction(action, ids) {
      if (action === 'clear') { this.clearSelection(); return; }
      if (!ids || ids.length === 0) return;
      try {
        if (action === 'complete') {
          await window.api.tasks.batchComplete(ids);
          window.ModuleApp.Toast.show(tr('toast.taskCompleted', `已批量完成 ${ids.length} 项`), 'success');
        } else if (action === 'delete') {
          const ok = await window.ModuleApp.Modal.confirm({ title: tr('batch.delete', '批量删除'), message: tr('batch.deleteConfirm', '确定删除选中的 {count} 项吗?', { count: ids.length }) });
          if (!ok) return;
          const scopeBefore = [...(this._state.state.projectScopeIds || [])];
          const result = await window.api.tasks.batchDelete(ids);
          await this._deps.loadTasks();
          const PS = window.ModuleApp.ProjectScope;
          const promoted = (result && result.promotedTasks) || [];
          const leftScope = scopeBefore.length > 0 && promoted.some(p =>
            !PS?.isTaskInScope?.(this._state.state.tasks, this._state.state.projectScopeIds, p.id)
          );
          if (leftScope) {
            window.ModuleApp.Toast.show(
              tr('toast.deleteSuccess', `已批量删除；有 ${promoted.length} 个已完成子任务升为顶层，不在当前项目内`),
              'warning'
            );
          } else {
            window.ModuleApp.Toast.show(tr('toast.deleteSuccess', `已批量删除 ${ids.length} 项`), 'warning');
          }
          this.clearSelection();
          this._deps.render();
          await this._deps.refreshUndoUI();
          return;
        } else if (action.startsWith('priority-')) {
          const p = action === 'priority-clear' ? null : action.replace('priority-', '');
          await window.api.tasks.batchSetPriority(ids, p);
          window.ModuleApp.Toast.show(tr('toast.taskUpdated', '已更新优先级'), 'success');
        }
      } catch (err) {
        window.ModuleApp.Toast.show(tr('toast.saveFailed', '操作失败: {error}', { error: err.message }), 'error');
        return;
      }
      this.clearSelection();
      await this._deps.loadTasks();
      this._deps.render();
      await this._deps.refreshUndoUI();
    },

    // ===== 自动规划引擎联动 =====
    async applyAutoPlan(editedTaskId) {
      if (!editedTaskId) return;
      await this._deps.loadTasks();
      this._deps.render();
      const state = this._state.state;
      if (!state.autoPlan) return;
      const ancestors = [];
      let cur = state.tasks.find(t => t.id === editedTaskId);
      const guard = new Set();
      while (cur && cur.parentId && !guard.has(cur.parentId)) {
        guard.add(cur.parentId);
        const p = state.tasks.find(t => t.id === cur.parentId);
        if (p) { ancestors.push(p); cur = p; } else break;
      }
      if (ancestors.length > 0) {
        window.ModuleApp.Toast.show(`已自动规划 ${ancestors.length} 个母任务`, 'success');
      }
    },

    // ===== 选择与层级工具 =====
    getTaskLevel(task) {
      if (!task) return -1;
      let level = 0, current = task;
      const visited = new Set();
      while (current.parentId) {
        if (visited.has(current.id)) break;
        visited.add(current.id);
        level++;
        current = this._state.state.tasks.find(t => t.id === current.parentId);
        if (!current) break;
      }
      return level;
    },

    // Descendant extra depth among ACTIVE children only (leaf=0).
    // 已完成子孙仍占 parentId，但不参与拖拽深度——否则界面上看是叶子，却拖不进深层落点。
    getSubtreeMaxDepth(taskId) {
      const children = this._state.state.tasks.filter(t => t.parentId === taskId && !t.completed);
      if (children.length === 0) return 0;
      let max = 0;
      for (const child of children) max = Math.max(max, 1 + this.getSubtreeMaxDepth(child.id));
      return max;
    },

    selectTask(id) {
      this._state.patch({ selectedId: id, anchorId: id });
      document.querySelectorAll('.task-row').forEach(r => r.classList.toggle('selected', r.dataset.id === id));
      this.updateQuickInputHint();
      // 焦点留在列表容器，保证 ↑↓/Enter/Space/n 可用；底栏需输入时用户再点 #quickInput
      const vc = document.getElementById('viewContainer');
      if (vc) vc.focus({ preventScroll: true });
      // ↑↓ 换行时滚入视口（nearest 少抖动；出框时才滚）
      const row = document.querySelector(`.task-row[data-id="${id}"]`);
      if (row) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },

    clearSelection() {
      document.querySelectorAll('.task-row').forEach(r => {
        r.classList.remove('selected');
        r.classList.remove('multi-selected');
      });
      this._state.patch({ selectedId: null, anchorId: null, multiSelect: [] });
      this.updateQuickInputHint();
      window.ModuleApp.BatchBar.update();
    },

    toggleMultiSelect(id, withShift) {
      const state = this._state.state;
      let newMulti = new Set(state.multiSelect);
      let newAnchor = state.anchorId;

      if (withShift && state.anchorId) {
        const rows = Array.from(document.querySelectorAll('.task-row'));
        const anchorIdx = rows.findIndex(r => r.dataset.id === state.anchorId);
        const curIdx = rows.findIndex(r => r.dataset.id === id);
        if (anchorIdx >= 0 && curIdx >= 0) {
          const [a, b] = anchorIdx < curIdx ? [anchorIdx, curIdx] : [curIdx, anchorIdx];
          for (let i = a; i <= b; i++) newMulti.add(rows[i].dataset.id);
        }
      } else {
        if (newMulti.has(id)) newMulti.delete(id); else newMulti.add(id);
        newAnchor = id;
      }
      this._state.patch({ multiSelect: [...newMulti], anchorId: newAnchor });
      window.ModuleApp.BatchBar.update();
    },

    updateQuickInputHint() {
      const hint = document.getElementById('quickInputHint');
      const clearBtn = document.getElementById('quickInputClear');
      if (!hint) return;
      const state = this._state.state;
      const sId = state.selectedId;
      const PS = window.ModuleApp.ProjectScope;
      const scopeIds = state.projectScopeIds || [];
      const scoped = scopeIds.length === 1;
      const scopeRoot = scoped ? state.tasks.find(t => t.id === scopeIds[0]) : null;

      if (!sId) {
        if (scoped && scopeRoot) {
          hint.textContent = `↵ ${scopeRoot.content}`;
          hint.classList.add('has-selection');
        } else {
          hint.textContent = tr('modal.createTask', '回车新建一级任务');
          hint.classList.remove('has-selection');
        }
        if (clearBtn) clearBtn.hidden = true;
        return;
      }
      const task = state.tasks.find(t => t.id === sId);
      if (!task) {
        this._state.patch({ selectedId: null });
        if (scoped && scopeRoot) {
          hint.textContent = `↵ ${scopeRoot.content}`;
          hint.classList.add('has-selection');
        } else {
          hint.textContent = tr('modal.createTask', '回车新建一级任务');
          hint.classList.remove('has-selection');
        }
        if (clearBtn) clearBtn.hidden = true;
        return;
      }
      const level = this.getTaskLevel(task);
      const maxLv = window.ModuleApp.Constants.MAX_LEVEL;
      if (level >= maxLv) {
        hint.textContent = `${task.content} · ${tr('hierarchy.maxLevelReached', '已到最深层')}`;
        hint.classList.remove('has-selection');
      } else {
        hint.textContent = `${tr('hierarchy.addSubtask', '添加子任务')}: ${task.content}`;
        hint.classList.add('has-selection');
      }
      if (clearBtn) clearBtn.hidden = false;
    },

    /**
     * 快速新建：聚焦底栏（弹窗仅用于编辑备注等详情）
     * @param {{ parentId?: string|null, asRoot?: boolean }} [opts]
     *   parentId — 选中该任务后建子任务
     *   asRoot   — 清选中，按 scope/顶层默认落点（顶栏 +）
     */
    focusQuickCreate(opts = {}) {
      const state = this._state.state;
      if (state.view !== 'hierarchy' && state.view !== 'deadline') {
        window.ModuleApp.Toast.show(tr('hierarchy.title', '请在「层级」或「截止日期」视图中添加任务'), 'info');
        return;
      }
      const parentId = opts.parentId || null;
      const asRoot = !!opts.asRoot;
      if (asRoot) {
        this.clearSelection();
      } else if (parentId) {
        const task = state.tasks.find(t => t.id === parentId);
        if (!task) return;
        if (this.getTaskLevel(task) >= window.ModuleApp.Constants.MAX_LEVEL) {
          window.ModuleApp.Toast.show(tr('hierarchy.maxLevelReached', '已达五级上限，无法再添加子任务'), 'warning');
          return;
        }
        this.selectTask(parentId);
      }
      this.updateQuickInputHint();
      const qi = document.getElementById('quickInput');
      if (qi) {
        // n/＋ 刚唤起底栏：短窗口内空 Enter/Space 不误触编辑/完成（不依赖 blur，CDP/焦点迁移不可靠）
        this._quickCreateArmedUntil = Date.now() + 2500;
        if (!this._quickCreateGuardBound) {
          this._quickCreateGuardBound = true;
          qi.addEventListener('input', () => { this._quickCreateArmedUntil = 0; });
        }
        qi.focus();
      }
    },

    /** 底栏是否处于「刚唤起新建」态（供 KeyboardController 询问） */
    isQuickCreateArmed() {
      return Date.now() < (this._quickCreateArmedUntil || 0);
    },


    openEditModal(id) {
      const task = this._state.state.tasks.find(t => t.id === id);
      if (!task) return;
      this._state.patch({ modalTask: { mode: 'edit', id } });
      window.ModuleApp.Modal.showTaskModal('edit', task, tr('hierarchy.dragHint', '提示：拖拽行可以改变父子关系；编辑此处不改变层级'));
    },

    // 视图点击事件委托（替代 app.js 内的 attachActionHandlers）
    attachActionHandlers() {
      const vc = document.getElementById('viewContainer');
      if (!vc) return;
      vc.addEventListener('click', e => {
        const actionMap = {
          '[data-edit]': el => this.openEditModal(el.dataset.edit),
          '[data-add-child]': el => this.focusQuickCreate({ parentId: el.dataset.addChild }),
          '[data-ai-breakdown]': el => window.ModuleApp.HierarchyView?.openAiBreakdown?.(el.dataset.aiBreakdown),
          '[data-complete]': el => this.handleComplete(el.dataset.complete),
          '[data-delete]': el => this.handleDelete(el.dataset.delete),
          '[data-uncomplete]': el => this.handleUncomplete(el.dataset.uncomplete),
          '[data-toggle]': el => {
            const id = el.dataset.toggle;
            const newCol = new Set(this._state.state.collapsed);
            if (newCol.has(id)) newCol.delete(id); else newCol.add(id);
            // Bug-D 修复：折叠/展开会改变 DOM 索引，继续用旧 anchorId 会导致 Shift 连选错位
            this._state.patch({ collapsed: [...newCol], anchorId: null });
            this._deps.render();
          },
          '[data-notes]': (el, evt) => {
            evt.stopPropagation();
            const t = this._state.state.tasks.find(x => x.id === el.dataset.notes);
            if (t) window.ModuleApp.Modal.showNotesModal(t);
          }
        };

        for (const [selector, handler] of Object.entries(actionMap)) {
          const el = e.target.closest(selector);
          if (el) return handler(el, e);
        }

        const row = e.target.closest('.task-row');
        if (row && !e.target.closest('.task-action-btn, .notes-indicator, .task-toggle, .task-handle, .task-priority-badge, .task-status-badge, .deadline')) {
          const id = row.dataset.id;
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            this.toggleMultiSelect(id, e.shiftKey);
            this.selectTask(id);
          } else {
            if (this._state.state.multiSelect.size > 0) this.clearSelection();
            if (this._state.state.selectedId === id || this._state.state.multiSelect.has(id)) this.clearSelection();
            else this.selectTask(id);
          }
        } else if (!row) {
          // Bug-fix: 空白区域点击也要清选区。行点击时 row 有值走上面分支；无行元素时走这里兜底。
          if (this._state.state.selectedId || this._state.state.multiSelect.size > 0) this.clearSelection();
        }
      });

      // 双击行 → 编辑（避开按钮/拖柄；层级与截止共用）
      vc.addEventListener('dblclick', e => {
        if (e.target.closest('.task-action-btn, .notes-indicator, .task-toggle, .task-handle, .task-priority-badge, .task-status-badge, input, textarea, select, button')) return;
        const row = e.target.closest('.task-row[data-id]');
        if (!row) return;
        e.preventDefault();
        this.openEditModal(row.dataset.id);
      });
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.TaskController = TaskController;
})();
