// Module — 视图：备忘录（IIFE 隔离，从 app.js 提取）
// 修复：1) 补回顶部"新建便签"输入框（CSS .notes-create / .note-input 已存在但被遗漏）
//      2) 渲染改用 .note-card / .notes-list 类（与 styles.css 已存在的 .note-card* 样式一致）
//      3) 增加 全部/置顶 筛选 + 颜色/置顶/编辑/删除 全部支持
(function() {
  // 颜色名 → 实际色值（与 widget.html 中的 .color-* 一致）
  const COLOR_MAP = {
    default: 'var(--primary)',   // 主色（CSS 变量）
    yellow:  '#eab308',
    green:   '#22c55e',
    pink:    '#ec4899',
    blue:    '#3b82f6',
  };
  const COLOR_LIST = ['default', 'yellow', 'green', 'pink', 'blue'];

  // 内部工具：格式化日期（短格式 "M/D"）
  function _fmtDateShort(iso) {
    if (!iso) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [, m, d] = iso.split('-');
      return m + '/' + d;
    }
    const dt = new Date(iso);
    return (dt.getMonth() + 1) + '/' + dt.getDate();
  }

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
    }
  }

  function _escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const NotesView = {
    _editingId: null,
    _newColor: 'default',
    _container: null,
    _newDraft: '',
    _editDraft: null,
    _composing: false,
    _pendingEditSave: null,
    _viewVersion: 0,
    _aiExtractingIds: new Set(),

    captureDrafts() {
      const input = this._container?.querySelector('#noteNewInput');
      if (input) this._newDraft = input.value;
      const edit = this._editingId && document.getElementById(`noteEdit_${this._editingId}`);
      if (edit && this._container?.contains(edit)) this._editDraft = edit.value;
    },

    mount(container) {
      this._viewVersion++;
      this._container = container;
      this._newColor = 'default';
      this.bindEvents();
    },

    unmount() {
      this._viewVersion++;
      this._container = null;
      if (this._globalClick) {
        document.removeEventListener('click', this._globalClick, { capture: true });
        this._globalClick = null;
      }
    },

    // render 由 app.js 调用，接收 state 和 actionType
    render(state, actionType) {
      if (!this._container) return;
      if (state.view && state.view !== 'notes') return;
      if (this._composing) {
        // Composition events can end after navigation has detached their textarea.
        const active = document.activeElement;
        if (active && this._container.contains(active)
          && (active.id === 'noteNewInput' || active.id?.startsWith('noteEdit_'))) return;
        this._composing = false;
      }

      // Preserve drafts even for explicit REPLACE, blurred inputs and filter changes.
      this.captureDrafts();
      const active = document.activeElement;
      const focus = active && this._container.contains(active)
        && (active.id === 'noteNewInput' || active.id?.startsWith('noteEdit_'))
        ? { id: active.id, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
        : null;

      const { notes, notesFilter } = state;
      if (this._editingId && !notes.some(n => n.id === this._editingId)) {
        // A peer deleted the note: rescue its unsaved text instead of dropping it.
        if (this._editDraft) this._newDraft = [this._newDraft, this._editDraft].filter(Boolean).join('\n');
        this._editingId = null;
        this._editDraft = null;
      }
      const filtered = notesFilter === 'pinned'
        ? notes.filter(n => n.pinned)
        : notes;

      const filter = notesFilter || 'all';

      this._container.innerHTML = `
        <div class="notes-view">
          <!-- 顶部：新建便签输入框（修复点 1：补回被遗漏的输入栏） -->
          <div class="notes-create">
            <textarea id="noteNewInput" class="note-input" rows="3"
              placeholder="${_t('notes.placeholder', null, '记录想法、会议纪要或待办碎片...（Ctrl+Enter 添加）', 'Jot down ideas, meeting notes, or to-dos... (Ctrl+Enter to add)')}">${_escapeHtml(this._newDraft)}</textarea>
            <div class="notes-create-actions">
              <div class="note-color-picker" id="noteNewColorPicker">
                ${COLOR_LIST.map(c => `
                  <button type="button" class="note-color-btn ${c === this._newColor ? 'active' : ''}"
                          data-color="${c}"
                          style="--c:${COLOR_MAP[c]}"
                          title="${c}"></button>
                `).join('')}
              </div>
              <div style="display:flex;gap:8px;">
                <button type="button" class="btn btn-ghost" id="noteNewCancel">${_t('common.clear', null, '清空', 'Clear')}</button>
                <button type="button" class="btn btn-primary" id="noteNewSubmit">+ ${_t('notes.newNote', null, '添加便签', 'New Note')}</button>
              </div>
            </div>
          </div>

          <!-- 工具栏：筛选 -->
          <div class="notes-toolbar">
            <div class="notes-filter" id="notesFilterBar">
              <button type="button" class="notes-filter-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">
                ${_t('notes.filterAll', null, '全部', 'All')} <span class="notes-filter-count">${notes.length}</span>
              </button>
              <button type="button" class="notes-filter-btn ${filter === 'pinned' ? 'active' : ''}" data-filter="pinned">
                📌 ${_t('notes.filterPinned', null, '置顶', 'Pinned')} <span class="notes-filter-count">${notes.filter(n => n.pinned).length}</span>
              </button>
            </div>
          </div>

          <!-- 便签列表 -->
          ${filtered.length === 0
            ? `<div class="empty-state">
                <div class="empty-state-icon">📝</div>
                <div class="empty-state-title">${filter === 'pinned'
                  ? _t('notes.emptyPinnedTitle', null, '没有置顶便签', 'No pinned notes')
                  : _t('notes.emptyTitle', null, '还没有便签', 'No notes yet')}</div>
                <div class="empty-state-hint">${filter === 'pinned'
                  ? _t('notes.emptyPinnedHint', null, '点击便签卡片右上角的图钉按钮置顶', 'Click the pin button on a note card to pin it')
                  : _t('notes.empty', null, '在顶部输入框写点什么吧', 'Click "New Note" or type above to start writing.')}</div>
              </div>`
            : `<div class="notes-list">
                ${filtered.map(n => this._renderNote(n)).join('')}
              </div>`
          }
        </div>
      `;

      this._bindInner();
      if (focus) {
        const restored = document.getElementById(focus.id);
        if (restored && this._container.contains(restored)) {
          restored.focus({ preventScroll: true });
          if (focus.start != null) restored.setSelectionRange(focus.start, focus.end, focus.direction);
        }
      }
    },

    _renderNote(note) {
      const editClass = this._editingId === note.id ? 'editing' : '';
      const colorKey = COLOR_MAP[note.color] ? note.color : 'default';
      const colorVal = COLOR_MAP[colorKey];
      return `
        <div class="note-card ${note.pinned ? 'pinned' : ''} ${editClass}"
             data-note-id="${note.id}"
             style="--note-color:${colorVal}">
          ${note.pinned ? `<div class="note-pin-badge">📌 ${_t('notes.pinnedBadge', null, '已置顶', 'Pinned')}</div>` : ''}
          <div class="note-card-content" id="noteContent_${note.id}">${this._editingId === note.id
            ? `<textarea id="noteEdit_${note.id}" class="note-input" rows="3">${_escapeHtml(this._editDraft ?? note.content ?? '')}</textarea>`
            : _escapeHtml(note.content || '')}</div>
          <div class="note-card-time">${_fmtDateShort(note.updatedAt || note.createdAt)}</div>
          <div class="note-card-actions">
            <button class="note-action note-action-ai" data-note-action="aiExtract" data-note-id="${note.id}" title="${_t('notes.aiExtractTasks', null, 'AI 提取任务', 'AI Extract Tasks')}" aria-label="${_t('notes.aiExtractTasks', null, 'AI 提取任务', 'AI Extract Tasks')}"${this._aiExtractingIds.has(note.id) ? ' disabled' : ''}>✨ ${_t('notes.aiShort', null, '提取', 'Extract')}</button>
            <button class="note-action" data-note-action="pin" data-note-id="${note.id}" title="${note.pinned ? _t('notes.unpin', null, '取消置顶', 'Unpin') : _t('notes.pin', null, '置顶', 'Pin')}">${note.pinned ? '📌' : '📍'}</button>
            <button class="note-action" data-note-action="color" data-note-id="${note.id}" title="${_t('notes.colorLabel', null, '便签颜色', 'Note Color')}">🎨</button>
            <button class="note-action" data-note-action="edit" data-note-id="${note.id}" title="${_t('common.edit', null, '编辑', 'Edit')}">✏️</button>
            <button class="note-action danger" data-note-action="delete" data-note-id="${note.id}" title="${_t('common.delete', null, '删除', 'Delete')}">🗑</button>
          </div>
          <div class="note-color-picker" id="colorPicker_${note.id}" style="margin-top:8px;">
            ${COLOR_LIST.map(c => `
              <button type="button" class="note-color-btn ${c === note.color ? 'active' : ''}"
                      data-color-target="${note.id}" data-color="${c}"
                      style="--c:${COLOR_MAP[c]}"></button>
            `).join('')}
          </div>
        </div>`;
    },

    // 渲染后绑定：筛选 / 新建 / 卡片操作
    _bindInner() {
      // 筛选
      const filterBar = this._container.querySelector('#notesFilterBar');
      if (filterBar) {
        filterBar.addEventListener('click', (e) => {
          const btn = e.target.closest('.notes-filter-btn');
          if (!btn) return;
          this.setFilter(btn.dataset.filter);
        });
      }

      // 新建输入框：Ctrl+Enter 提交
      const newInput = this._container.querySelector('#noteNewInput');
      if (newInput) {
        newInput.addEventListener('input', () => { this._newDraft = newInput.value; });
        newInput.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            this._submitNew();
          } else if (e.key === 'Escape') {
            newInput.value = '';
            this._newDraft = '';
            newInput.blur();
          }
        });
      }

      // 颜色选择（新建区）
      const newPicker = this._container.querySelector('#noteNewColorPicker');
      if (newPicker) {
        newPicker.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-color]');
          if (!btn || !newPicker.contains(btn)) return;
          this._newColor = btn.dataset.color;
          newPicker.querySelectorAll('.note-color-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.color === this._newColor);
          });
        });
      }

      // 提交 / 取消
      this._container.querySelector('#noteNewSubmit')?.addEventListener('click', () => this._submitNew());
      this._container.querySelector('#noteNewCancel')?.addEventListener('click', () => {
        const inp = this._container.querySelector('#noteNewInput');
        if (inp) inp.value = '';
        this._newDraft = '';
        inp?.focus();
      });

      // 卡片操作委托
      this._container.querySelectorAll('.note-card').forEach(card => {
        card.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-note-action]');
          if (!btn) return;
          e.stopPropagation();
          const id = btn.dataset.noteId;
          const action = btn.dataset.noteAction;
          if (action === 'edit')           this._startEdit(id);
          else if (action === 'delete')    this._delete(id);
          else if (action === 'pin')       this._togglePin(id);
          else if (action === 'color')     this._toggleColorPicker(id);
          else if (action === 'aiExtract') this._extractTasks(id, btn);
        });
        // 卡片内联颜色选择
        const picker = card.querySelector('.note-color-picker');
        if (picker) {
          picker.addEventListener('click', (e) => {
            const dot = e.target.closest('[data-color-target]');
            if (!dot) return;
            e.stopPropagation();
            this._setColor(dot.dataset.colorTarget, dot.dataset.color);
          });
        }
      });
    },

    bindEvents() {
      this._container.addEventListener('compositionstart', (e) => {
        if (e.target.id === 'noteNewInput' || e.target.id?.startsWith('noteEdit_')) this._composing = true;
      });
      this._container.addEventListener('compositionend', (e) => {
        if (e.target.id !== 'noteNewInput' && !e.target.id?.startsWith('noteEdit_')) return;
        this._composing = false;
        if (window.ModuleApp.State.state.view === 'notes') this.render(window.ModuleApp.State.state, 'REPLACE');
      });
      this._container.addEventListener('input', (e) => {
        if (e.target.id === `noteEdit_${this._editingId}`) this._editDraft = e.target.value;
      });
      // 全局点击捕获：保存编辑（点击编辑面板外时自动保存）
      this._globalClick = async (e) => {
        if (!this._editingId) return;
        const editEl = document.getElementById(`noteEdit_${this._editingId}`);
        if (editEl && !editEl.contains(e.target) && !e.target.closest('[data-note-action="edit"]')) {
          await this._saveEdit(this._editingId);
        }
      };
      document.addEventListener('click', this._globalClick, { capture: true });
    },

    async _submitNew() {
      const input = this._container?.querySelector('#noteNewInput');
      if (!input) return;
      const content = (input.value || '').trim();
      if (!content) {
        window.ModuleApp.Toast.show(_t('notes.emptyContentWarn', null, '便签内容不能为空', 'Note content cannot be empty'), 'warn');
        input.focus();
        return;
      }
      try {
        await window.api.notes.create({ content, color: this._newColor });
        // Do not erase additional text typed while the create request was pending.
        if (input.value.trim() === content) input.value = '';
        this._newDraft = input.value;
        // 跳过 sender 后发起方必须本地刷新；对端 widget 靠广播
        const notes = await window.api.notes.list();
        await window.ModuleApp.refreshUndoUI?.();
        window.ModuleApp.State.patch({ notes });
        this.render(window.ModuleApp.State.state, 'REPLACE');
      } catch (err) {
        console.error('[NotesView] create error:', err);
        window.ModuleApp.Toast.show(_t('toast.saveFailed', { error: err.message || err }, '创建失败: ' + (err.message || err), 'Failed to create: ' + (err.message || err)), 'error');
      }
    },

    async _startEdit(id) {
      const note = window.ModuleApp.State.state.notes.find(n => n.id === id);
      if (!note) return;
      if (this._editingId === id) return;
      if (this._editingId) {
        await this._saveEdit(this._editingId);
        if (this._editingId) return;
      }
      this._editingId = id;
      this._editDraft = note.content || '';
      const contentEl = document.getElementById(`noteContent_${id}`);
      if (!contentEl) return;
      contentEl.innerHTML = `<textarea id="noteEdit_${id}" class="note-input"
        rows="${Math.max(3, (note.content || '').split('\n').length + 1)}"
        style="margin-top:6px;">${_escapeHtml(note.content || '')}</textarea>`;
      const editEl = document.getElementById(`noteEdit_${id}`);
      if (editEl) {
        editEl.focus();
        // 光标移到最后
        const len = editEl.value.length;
        try { editEl.setSelectionRange(len, len); } catch (_) {}
      }
    },

    async _saveEdit(id) {
      if (this._pendingEditSave) return this._pendingEditSave;
      if (this._editingId !== id) return;
      const input = document.getElementById(`noteEdit_${id}`);
      const draft = input?.value ?? this._editDraft;
      if (draft == null) return;
      const content = draft.trim();
      if (!content) {
        window.ModuleApp.Toast.show(_t('notes.emptyEditWarn', null, '便签内容不能为空，已取消修改', 'Note content cannot be empty; edit cancelled'), 'warning');
        this._editingId = null;
        this._editDraft = null;
        // 强制执行重新渲染以恢复原内容，防止 UI 显示空白卡片
        this.render(window.ModuleApp.State.state, 'REPLACE');
        return;
      }
      // Keep ownership until persistence succeeds; switching notes must await this save.
      this._editDraft = draft;
      const pending = this._commitEdit(id, content);
      this._pendingEditSave = pending;
      try {
        await pending;
      } finally {
        if (this._pendingEditSave === pending) this._pendingEditSave = null;
      }
    },

    async _commitEdit(id, content) {
      try {
        await window.api.notes.update(id, { content });
        const notes = await window.api.notes.list();
        await window.ModuleApp.refreshUndoUI?.();
        window.ModuleApp.State.patch({ notes });
        const input = document.getElementById(`noteEdit_${id}`);
        const latest = input?.value ?? this._editDraft ?? content;
        if (this._editingId === id && latest.trim() === content) {
          this._editingId = null;
          this._editDraft = null;
        }
        this.render(window.ModuleApp.State.state, 'REPLACE');
      } catch (err) {
        console.error('[NotesView] save error:', err);
        this.render(window.ModuleApp.State.state, 'REPLACE');
        window.ModuleApp.Toast.show(_t('toast.saveFailed', { error: err.message || err }, '保存失败: ' + (err.message || err), 'Failed to save: ' + (err.message || err)), 'error');
      }
    },

    async _delete(id) {
      const confirmed = await window.ModuleApp.Modal?.confirm(_t('notes.deleteConfirm', null, '确定要删除这条备忘录吗？', 'Delete this note?'));
      if (!confirmed) return;
      try {
        await window.api.notes.delete(id);
        const notes = await window.api.notes.list();
        await window.ModuleApp.refreshUndoUI?.();
        window.ModuleApp.State.patch({ notes });
        this.render(window.ModuleApp.State.state, 'REPLACE');
      } catch (err) {
        console.error('[NotesView] delete error:', err);
        window.ModuleApp.Toast.show(_t('toast.deleteFailed', { error: err.message || err }, '删除失败', 'Failed to delete'), 'error');
      }
    },

    async _togglePin(id) {
      const note = window.ModuleApp.State.state.notes.find(n => n.id === id);
      if (!note) return;
      try {
        await window.api.notes.update(id, { pinned: !note.pinned });
        const notes = await window.api.notes.list();
        await window.ModuleApp.refreshUndoUI?.();
        window.ModuleApp.State.patch({ notes });
        this.render(window.ModuleApp.State.state, 'REPLACE');
      } catch (err) {
        console.error('[NotesView] pin error:', err);
        window.ModuleApp.Toast.show(_t('notes.opFailed', null, '操作失败', 'Operation failed'), 'error');
      }
    },

    async _setColor(id, color) {
      try {
        await window.api.notes.update(id, { color });
        const notes = await window.api.notes.list();
        await window.ModuleApp.refreshUndoUI?.();
        window.ModuleApp.State.patch({ notes });
        this.render(window.ModuleApp.State.state, 'REPLACE');
      } catch (err) {
        console.error('[NotesView] color error:', err);
        window.ModuleApp.Toast.show(_t('notes.opFailed', null, '操作失败', 'Operation failed'), 'error');
      }
    },

    async _extractTasks(id, btn) {
      if (btn?.disabled || this._aiExtractingIds.has(id)) return;
      const origHtml = btn ? btn.innerHTML : '';
      const version = this._viewVersion;
      this._aiExtractingIds.add(id);
      if (btn) {
        btn.disabled = true;
        btn.classList.add('ai-loading');
        btn.textContent = '⏳';
      }
      try {
        const items = await window.api.ai.notesToTasks(id, _locale());
        if (version !== this._viewVersion || !this._container) return;
        if (!Array.isArray(items) || items.length === 0) {
          window.ModuleApp.Toast?.show(_t('notes.aiExtractEmpty', null, '未从备忘录中识别到可执行任务', 'No actionable tasks found in this note'), 'info');
          return;
        }
        window.ModuleApp.Toast?.show(_t('notes.aiExtractSuccess', { count: items.length }, `已提取 ${items.length} 个任务`, `Extracted ${items.length} tasks`), 'success');
        this._showExtractModal(items, id);
      } catch (err) {
        if (version !== this._viewVersion || !this._container) return;
        const msg = String(err?.message || err || '');
        if (msg.includes('ERR_API_KEY_MISSING')) {
          const ok = await window.ModuleApp?.Modal?.confirm?.({
            title: _t('ai.apiKeyMissingTitle', null, '需要配置 API Key', 'API Key Required'),
            message: _t('ai.apiKeyMissingConfirm', null, '尚未配置 AI API Key，是否立即打开设置进行配置？', 'AI API Key is not configured. Open Settings now?'),
          });
          if (ok) window.api?.app?.openSettings?.();
        } else if (msg.includes('ERR_INPUT_TOO_LARGE')) {
          window.ModuleApp.Toast?.show(_t('ai.inputTooLargeNote', null, '笔记内容过长，请分段或精简后再试', 'Note content is too large; please split or shorten it and try again'), 'error');
        } else {
          window.ModuleApp.Toast?.show(_t('notes.aiExtractFailed', { error: err?.message || err }, 'AI 提取任务失败: ' + (err?.message || err), 'AI task extraction failed: ' + (err?.message || err)), 'error');
        }
      } finally {
        this._aiExtractingIds.delete(id);
        const currentBtn = this._container?.querySelector(`.note-action-ai[data-note-id="${CSS.escape(String(id))}"]`);
        if (currentBtn && currentBtn !== btn) {
          currentBtn.disabled = false;
          currentBtn.classList.remove('ai-loading');
        }
        if (btn) {
          btn.disabled = false;
          btn.classList.remove('ai-loading');
          btn.innerHTML = origHtml;
        }
      }
    },

    _showExtractModal(items, sourceNoteId) {
      let modal = document.getElementById('aiNotesExtractModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'aiNotesExtractModal';
        modal.className = 'modal';
        modal.hidden = true;
        document.body.appendChild(modal);
      }

      const appState = window.ModuleApp.State?.state || {};
      const rootProjects = (appState.tasks || []).filter(t => !t.completed && !t.parentId);
      const defaultParentId = (appState.projectScopeIds || [])[0] || '';
      const parentOptionsHtml = [
        `<option value="">${_t('notes.topLevelTask', null, '顶层任务', 'Top-level')}</option>`,
        ...rootProjects.map(p => `<option value="${_escapeHtml(String(p.id))}" ${String(p.id) === String(defaultParentId) ? 'selected' : ''}>${_escapeHtml(p.content || '')}</option>`)
      ].join('');

      const _normPriority = (val) => {
        const v = String(val || '').toLowerCase();
        if (v === 'p0' || v === 'high') return 'p0';
        if (v === 'p1' || v === 'medium') return 'p1';
        if (v === 'p2' || v === 'low') return 'p2';
        return '';
      };

      const rowsHtml = items.map((item, idx) => {
        const p = _normPriority(item.priority);
        const dl = String(item.deadline || '').slice(0, 10);
        const sd = String(item.startDate || item.start_date || '').slice(0, 10);
        return `
          <div class="ai-task-row" data-idx="${idx}">
            <div class="ai-task-row-main">
              <input type="checkbox" class="ai-task-check" checked />
              <input type="text" class="ai-task-title-input" value="${_escapeHtml(item.content || '')}" placeholder="${_t('task.contentPlaceholder', null, '任务名称', 'Task title')}" />
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

      modal.innerHTML = `
        <div class="modal-backdrop" data-ai-close></div>
        <div class="modal-card ai-modal-card">
          <div class="modal-header">
            <h2>✨ ${_t('notes.aiExtractTasks', null, 'AI 提取任务', 'AI Extract Tasks')}</h2>
            <button type="button" class="btn-close" data-ai-close>✕</button>
          </div>
          <div class="modal-body">
            <label class="ai-task-meta-field" style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
              <span>${_t('notes.targetProject', null, '归属项目', 'Target Project')}</span>
              <select id="aiExtractParentSelect" class="ai-task-priority-select" style="flex:1;">${parentOptionsHtml}</select>
            </label>
            <div class="ai-task-list">${rowsHtml}</div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" data-ai-close>${_t('common.cancel', null, '取消', 'Cancel')}</button>
            <button type="button" class="btn btn-primary" id="aiExtractConfirmBtn">✓ ${_t('notes.createExtractedTasks', null, '批量创建任务', 'Create Tasks')}</button>
          </div>
        </div>`;

      modal.hidden = false;
      const onKeyDown = (e) => {
        if (e.key === 'Escape') closeModal();
      };
      const closeModal = () => {
        document.removeEventListener('keydown', onKeyDown);
        if (modal._escHandler === onKeyDown) modal._escHandler = null;
        modal.hidden = true;
      };
      if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
      modal._escHandler = onKeyDown;
      document.addEventListener('keydown', onKeyDown);
      modal.querySelectorAll('[data-ai-close]').forEach(el => el.addEventListener('click', closeModal));

      modal.querySelector('#aiExtractConfirmBtn')?.addEventListener('click', async () => {
        const confirmBtn = modal.querySelector('#aiExtractConfirmBtn');
        const selectedParentId = modal.querySelector('#aiExtractParentSelect')?.value || null;
        const rows = [...modal.querySelectorAll('.ai-task-row')];
        const tasksToCreate = [];
        for (const row of rows) {
          const checked = row.querySelector('.ai-task-check')?.checked;
          if (!checked) continue;
          const idx = Number(row.dataset.idx);
          const orig = items[idx] || {};
          const content = (row.querySelector('.ai-task-title-input')?.value || '').trim();
          if (!content) continue;
          const priority = row.querySelector('.ai-task-priority-select')?.value || null;
          const startDate = row.querySelector('.ai-task-start-input')?.value || null;
          const deadline = row.querySelector('.ai-task-deadline-input')?.value || null;
          tasksToCreate.push({
            content,
            priority: priority || null,
            startDate: startDate || null,
            deadline: deadline || null,
            parentId: selectedParentId || null,
            sourceNoteId: sourceNoteId || null,
          });
        }
        if (tasksToCreate.length === 0) {
          window.ModuleApp.Toast?.show(_t('breakdown.selectAtLeastOne', null, '请至少选择一个任务', 'Please select at least one task'), 'warn');
          return;
        }
        if (confirmBtn) confirmBtn.disabled = true;
        try {
          await window.api.tasks.batchCreate(tasksToCreate);
          await _reloadTasksAndRender();
          window.ModuleApp.Toast?.show(_t('toast.taskCreated', null, `已创建 ${tasksToCreate.length} 个任务`, `Created ${tasksToCreate.length} tasks`), 'success');
          closeModal();
        } catch (err) {
          window.ModuleApp.Toast?.show(_t('toast.saveFailed', { error: err?.message || err }, '创建失败: ' + (err?.message || err), 'Failed to create: ' + (err?.message || err)), 'error');
          if (confirmBtn) confirmBtn.disabled = false;
        }
      });
    },

    _toggleColorPicker(id) {
      // 关闭所有其他 picker,再切换当前
      this._container?.querySelectorAll('.note-color-picker[id^="colorPicker_"]').forEach(p => {
        if (p.id !== `colorPicker_${id}`) p.style.display = 'none';
      });
      const picker = document.getElementById(`colorPicker_${id}`);
      if (!picker) return;
      picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
    },

    // 供 app.js 调用：切换便签筛选
    setFilter(filter) {
      const State = window.ModuleApp.State;
      State.patch({ notesFilter: filter }, 'NOTES_FILTER');
      // 立即重绘，否则 state 变动不会自动触发 render
      this.render(State.state, 'REPLACE');
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.NotesView = NotesView;
})();
