// Module — 视图：层级视图（childrenMap + morphdom 增量）
(function() {
  function _t(key, params, zhFallback, enFallback) {
    const i18n = window.ModuleApp?.I18n;
    if (i18n && typeof i18n.t === 'function' && (!i18n.hasKey || i18n.hasKey(key))) {
      return i18n.t(key, params);
    }
    const loc = i18n?.getLocale?.() || 'zh-CN';
    let text = (loc === 'en-US' && enFallback) ? enFallback : (zhFallback || key);
    if (params && typeof text === 'string') {
      text = text.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
    }
    return text;
  }

  function _locale() {
    return window.ModuleApp?.I18n?.getLocale?.() || 'zh-CN';
  }

  function _escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function _reloadTasksAndRender() {
    if (typeof window.ModuleApp?.loadTasks === 'function') {
      await window.ModuleApp.loadTasks();
    } else if (typeof window.ModuleApp?.TaskController?._deps?.loadTasks === 'function') {
      await window.ModuleApp.TaskController._deps.loadTasks();
    } else {
      const tasks = await window.api.tasks.getAll();
      window.ModuleApp.State?.patch({ tasks });
    }
    await window.ModuleApp?.refreshUndoUI?.();
    if (typeof window.ModuleApp?.render === 'function') {
      await window.ModuleApp.render();
    } else if (typeof window.ModuleApp?.TaskController?._deps?.render === 'function') {
      await window.ModuleApp.TaskController._deps.render();
    } else if (window.ModuleApp?.State?.state) {
      HierarchyView.render(window.ModuleApp.State.state, 'REPLACE');
    }
  }

  function _flattenGeneratedItems(items, rootParentId, maxDepth = 2) {
    const flat = [];
    const walk = (list, parentId, depth) => {
      if (!Array.isArray(list) || depth > maxDepth) return;
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!item || !String(item.content || '').trim()) continue;
        const tempId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
          ? crypto.randomUUID()
          : `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${flat.length}`;
        flat.push({
          tempId,
          parentId,
          depth,
          content: String(item.content).trim(),
          priority: item.priority || null,
          startDate: item.startDate || item.start_date || null,
          deadline: item.deadline || null,
        });
        if (Array.isArray(item.children) && item.children.length > 0 && depth < maxDepth) {
          walk(item.children, tempId, depth + 1);
        }
      }
    };
    walk(items, rootParentId, 0);
    return flat;
  }

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
        const emptyTitle = search
          ? _t('hierarchy.emptySearchTitle', null, '没有匹配的任务', 'No matching tasks')
          : (scoped
            ? _t('hierarchy.emptyScopedTitle', null, '该项目下暂无任务', 'No tasks in this project')
            : _t('hierarchy.emptyTitle', null, '还没有主任务', 'No tasks yet'));
        const emptyHint = search
          ? _t('hierarchy.emptySearchHint', null, '试试别的关键词，或清空搜索框', 'Try another keyword or clear the search box')
          : (scoped
            ? _t('hierarchy.emptyScopedHint', null, '点右上角「+ 添加」或在底部输入在本项目下新建', 'Click "+ Add" or type below to create a task in this project')
            : _t('hierarchy.empty', null, '点右上角「+ 添加」或在底部输入内容回车创建', 'No tasks yet. Click "+ Add" to get started.'));
        const emptyHtml = `
          <div class="empty-state">
            <div class="empty-state-icon">${search ? '🔍' : '📋'}</div>
            <div class="empty-state-title">${emptyTitle}</div>
            <div class="empty-state-hint">${emptyHint}</div>
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

    },

    openAiBreakdown(taskId) {
      const tasks = window.ModuleApp.State?.state?.tasks || this._tasks || [];
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;

      let modal = document.getElementById('aiBreakdownModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'aiBreakdownModal';
        modal.className = 'modal';
        modal.hidden = true;
        document.body.appendChild(modal);
      }
      modal._aiReqToken = (modal._aiReqToken || 0) + 1;

      let generatedFlat = [];

      modal.innerHTML = `
        <div class="modal-backdrop" data-ai-close></div>
        <div class="modal-card ai-modal-card">
          <div class="modal-header">
            <h2>✨ ${_t('breakdown.title', null, 'AI 任务拆解', 'AI Task Breakdown')}</h2>
            <button type="button" class="btn-close" data-ai-close>✕</button>
          </div>
          <div class="modal-body">
            <div class="ai-target-task">
              <div class="ai-target-row">
                <span class="ai-target-label">${_t('breakdown.targetTask', null, '目标任务', 'Target Task')}:</span>
                <span class="ai-target-content">${_escapeHtml(task.content)}</span>
              </div>
              ${task.notes && task.notes.trim()
                ? `<div class="ai-target-notes">${_t('task.notes', null, '描述', 'Notes')}: ${_escapeHtml(task.notes.trim())}</div>`
                : `<div class="ai-target-notes muted">${_t('breakdown.noNotesHint', null, '暂无任务描述，建议补充拆解要求以获得更准确的子任务', 'No task description yet; add instructions below for better results')}</div>`}
            </div>
            <label class="ai-instruction-label" for="aiBreakdownInstruction">
              ${_t('breakdown.instructionLabel', null, '补充拆解要求（可选）', 'Additional Instructions (Optional)')}
            </label>
            <textarea id="aiBreakdownInstruction" class="ai-instruction-input" rows="2"
              placeholder="${_t('breakdown.instructionPlaceholder', null, '例如：按前后端联调步骤拆解，每步不超过半天...', 'e.g., Split into frontend/backend steps under half a day each...')}"></textarea>
            <div class="ai-breakdown-controls">
              <label class="ai-max-tasks-field" for="aiBreakdownMaxTasks">
                <span>${_t('breakdown.maxTasksLabel', null, '最多拆解任务数', 'Max Subtasks')} <em class="ai-required">*</em></span>
                <input type="number" id="aiBreakdownMaxTasks" class="ai-max-tasks-input" min="1" max="15" required
                  placeholder="${_t('breakdown.maxTasksPlaceholder', null, '必填 (1-15)', 'Req (1-15)')}" />
              </label>
              <button type="button" class="btn btn-primary btn-sm" id="aiBreakdownGenerateBtn">
                ✨ ${_t('breakdown.generate', null, '开始拆解', 'Break Down')}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" id="aiBreakdownRegenBtn" hidden>
                🔄 ${_t('breakdown.regenerate', null, '重新生成', 'Regenerate')}
              </button>
            </div>
            <div id="aiBreakdownPreviewSection" class="ai-breakdown-section" hidden>
              <div class="ai-preview-title">${_t('breakdown.previewTitle', null, '建议的子任务', 'Suggested Subtasks')}</div>
              <div id="aiBreakdownTruncateNotice" class="ai-truncate-notice" style="font-size:12px;color:#b45309;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);border-radius:6px;padding:6px 10px;margin-bottom:8px;" hidden></div>
              <div id="aiBreakdownList" class="ai-task-list"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" data-ai-close>${_t('common.cancel', null, '取消', 'Cancel')}</button>
            <button type="button" class="btn btn-primary" id="aiBreakdownConfirmBtn" hidden>
              ✓ ${_t('breakdown.addSelected', null, '添加选中子任务', 'Add Selected Subtasks')}
            </button>
          </div>
        </div>`;

      modal.hidden = false;
      if (modal._escHandler) {
        document.removeEventListener('keydown', modal._escHandler);
        modal._escHandler = null;
      }
      const closeModal = () => {
        modal._aiReqToken = (modal._aiReqToken || 0) + 1;
        modal.hidden = true;
        if (modal._escHandler) {
          document.removeEventListener('keydown', modal._escHandler);
          modal._escHandler = null;
        }
      };
      modal._escHandler = (e) => {
        if (e.key === 'Escape' && !modal.hidden) closeModal();
      };
      document.addEventListener('keydown', modal._escHandler);
      modal.querySelectorAll('[data-ai-close]').forEach(el => el.addEventListener('click', closeModal));

      const genBtn = modal.querySelector('#aiBreakdownGenerateBtn');
      const regenBtn = modal.querySelector('#aiBreakdownRegenBtn');
      const instrInput = modal.querySelector('#aiBreakdownInstruction');
      const maxTasksInput = modal.querySelector('#aiBreakdownMaxTasks');
      const previewSec = modal.querySelector('#aiBreakdownPreviewSection');
      const truncateNotice = modal.querySelector('#aiBreakdownTruncateNotice');
      const listEl = modal.querySelector('#aiBreakdownList');
      const confirmBtn = modal.querySelector('#aiBreakdownConfirmBtn');

      const _normPriority = (val) => {
        const v = String(val || '').toLowerCase();
        if (v === 'p0' || v === 'high') return 'p0';
        if (v === 'p1' || v === 'medium') return 'p1';
        if (v === 'p2' || v === 'low') return 'p2';
        return '';
      };

      const renderPreview = () => {
        listEl.innerHTML = generatedFlat.map((item, idx) => {
          const p = _normPriority(item.priority);
          const sd = String(item.startDate || '').slice(0, 10);
          const dl = String(item.deadline || '').slice(0, 10);
          return `
          <div class="ai-task-row" data-idx="${idx}" style="margin-left:${item.depth * 18}px;width:calc(100% - ${item.depth * 18}px);">
            <div class="ai-task-row-main">
              <input type="checkbox" class="ai-task-check" checked />
              <input type="text" class="ai-task-title-input" value="${_escapeHtml(item.content)}" />
            </div>
            <div class="ai-task-row-meta">
              <label class="ai-task-meta-field">
                <span>${_t('task.priority', null, '优先级', 'Priority')}</span>
                <select class="ai-task-priority-select">
                  <option value="" ${!p ? 'selected' : ''}>${_t('common.none', null, '无', 'None')}</option>
                  <option value="p0" ${p === 'p0' ? 'selected' : ''}>${_t('priority.p0Short', null, 'P0', 'P0')}</option>
                  <option value="p1" ${p === 'p1' ? 'selected' : ''}>${_t('priority.p1Short', null, 'P1', 'P1')}</option>
                  <option value="p2" ${p === 'p2' ? 'selected' : ''}>${_t('priority.p2Short', null, 'P2', 'P2')}</option>
                </select>
              </label>
              <label class="ai-task-meta-field">
                <span>${_t('task.startDate', null, '开始', 'Start')}</span>
                <input type="date" class="ai-task-date-input ai-task-start-input" value="${_escapeHtml(sd)}" />
              </label>
              <label class="ai-task-meta-field">
                <span>${_t('task.deadline', null, '截止', 'Due')}</span>
                <input type="date" class="ai-task-date-input ai-task-deadline-input" value="${_escapeHtml(dl)}" />
              </label>
            </div>
          </div>`;
        }).join('');
        previewSec.hidden = false;
        confirmBtn.hidden = false;
      };

      const runBreakdown = async (activeBtn) => {
        if (activeBtn?.disabled) return;
        const rawMax = String(maxTasksInput?.value || '').trim();
        const maxTasks = parseInt(rawMax, 10);
        if (!rawMax || !Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 15) {
          window.ModuleApp.Toast?.show(_t('breakdown.maxTasksRequired', null, '请先填写最多拆解任务数（1-15）', 'Please enter max subtasks (1-15) first'), 'warning');
          maxTasksInput?.focus();
          return;
        }
        const token = modal._aiReqToken;
        const instruction = (instrInput?.value || '').trim() || null;
        const origText = activeBtn.innerHTML;
        if (genBtn) genBtn.disabled = true;
        if (regenBtn) regenBtn.disabled = true;
        activeBtn.classList.add('ai-loading');
        activeBtn.textContent = `⏳ ${_t('breakdown.generating', null, '正在拆解任务...', 'Breaking down task...')}`;
        try {
          const result = await window.api.ai.breakdownTask(task.id, instruction, maxTasks, _locale());
          if (token !== modal._aiReqToken || modal.hidden) return;
          const rootContentTrimmed = String(task.content || '').trim();
          generatedFlat = _flattenGeneratedItems(result, task.id).filter(
            item => String(item.content || '').trim() !== rootContentTrimmed
          );
          if (generatedFlat.length === 0) {
            previewSec.hidden = true;
            confirmBtn.hidden = true;
            if (truncateNotice) truncateNotice.hidden = true;
            if (regenBtn) regenBtn.hidden = true;
            window.ModuleApp.Toast?.show(_t('breakdown.noNeedResult', null, '该任务当前信息较少或无需再拆解，可补充描述或要求后再试', 'No further breakdown needed, or add more description/instructions'), 'info');
            return;
          }
          if (truncateNotice) {
            if (generatedFlat.length >= maxTasks) {
              truncateNotice.textContent = `⚠️ ${_t('breakdown.truncatedNotice', { max: maxTasks }, `已按上限最多保留 ${maxTasks} 条，可调整上限或补充要求后重新生成`, `Kept up to ${maxTasks} subtasks per limit; adjust the limit or add instructions and regenerate`)}`;
              truncateNotice.hidden = false;
            } else {
              truncateNotice.hidden = true;
            }
          }
          if (regenBtn) regenBtn.hidden = false;
          renderPreview();
        } catch (err) {
          if (token !== modal._aiReqToken || modal.hidden) return;
          const msg = String(err?.message || err || '');
          if (msg.includes('ERR_API_KEY_MISSING')) {
            const ok = await window.ModuleApp?.Modal?.confirm?.({
              title: _t('ai.apiKeyMissingTitle', null, '需要配置 API Key', 'API Key Required'),
              message: _t('ai.apiKeyMissingConfirm', null, '尚未配置 AI API Key，是否立即打开设置进行配置？', 'AI API Key is not configured. Open Settings now?'),
            });
            if (ok) window.api?.app?.openSettings?.();
          } else {
            window.ModuleApp.Toast?.show(_t('breakdown.failed', { error: err?.message || err }, 'AI 任务拆解失败: ' + (err?.message || err), 'AI task breakdown failed: ' + (err?.message || err)), 'error');
          }
        } finally {
          if (token === modal._aiReqToken) {
            if (genBtn) genBtn.disabled = false;
            if (regenBtn) regenBtn.disabled = false;
            activeBtn.classList.remove('ai-loading');
            activeBtn.innerHTML = origText;
          }
        }
      };

      genBtn?.addEventListener('click', () => runBreakdown(genBtn));
      regenBtn?.addEventListener('click', () => runBreakdown(regenBtn));

      confirmBtn?.addEventListener('click', async () => {
        const rows = [...listEl.querySelectorAll('.ai-task-row')];
        const checkedTempIds = new Set();
        const tasksToCreate = [];
        for (const row of rows) {
          const checked = row.querySelector('.ai-task-check')?.checked;
          if (!checked) continue;
          const idx = Number(row.dataset.idx);
          const item = generatedFlat[idx];
          const content = (row.querySelector('.ai-task-title-input')?.value || '').trim();
          if (!item || !content) continue;
          checkedTempIds.add(item.tempId);
          const priority = row.querySelector('.ai-task-priority-select')?.value || null;
          const startDate = row.querySelector('.ai-task-start-input')?.value || null;
          const deadline = row.querySelector('.ai-task-deadline-input')?.value || null;
          const parentId = (item.parentId === task.id || checkedTempIds.has(item.parentId))
            ? item.parentId
            : task.id;
          tasksToCreate.push({
            id: item.tempId,
            content,
            parentId,
            priority: priority || null,
            startDate: startDate || null,
            deadline: deadline || null,
          });
        }
        if (tasksToCreate.length === 0) {
          window.ModuleApp.Toast?.show(_t('breakdown.selectAtLeastOne', null, '请至少选择一个子任务', 'Please select at least one subtask'), 'warn');
          return;
        }
        confirmBtn.disabled = true;
        try {
          await window.api.tasks.batchCreate(tasksToCreate);
          await _reloadTasksAndRender();
          window.ModuleApp.Toast?.show(_t('breakdown.success', { count: tasksToCreate.length }, `已添加 ${tasksToCreate.length} 个子任务`, `Added ${tasksToCreate.length} subtasks`), 'success');
          closeModal();
        } catch (err) {
          window.ModuleApp.Toast?.show(_t('breakdown.failed', { error: err?.message || err }, '添加失败: ' + (err?.message || err), 'Failed to add subtasks: ' + (err?.message || err)), 'error');
          confirmBtn.disabled = false;
        }
      });

      setTimeout(() => instrInput?.focus(), 30);
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
