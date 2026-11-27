// Module — 渲染进程中枢 (Core Router & Initializer)
'use strict';

const _api = window.api;

  window.ModuleApp = window.ModuleApp || {};

// 状态引用绑定：让 legacy 代码中对 state 的读写安全映射到响应式状态单例
const state = window.ModuleApp.State.state;

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


// Bug-2 修复：广播风暴防御——原子渲染锁，防止 onDataChange 快速连续触发时多个 render 并发执行
let _isRendering = false;
// 审计 2.3：dirty flag — safeRender 跳过时设为 true，下次广播自动补渲染
let _renderDirty = false;
let _initCompleted = false;
let _earlyDataUIBound = false;
async function safeRender() {
  if (_isRendering) {
    _renderDirty = true;  // 并发冲突时标记脏，render 完成后自检
    return;
  }
  _isRendering = true;
  try {
    do {
      _renderDirty = false;
      await CoreServices.render();
    } while (_renderDirty);
  } catch (error) {
    showDataError(error);
  } finally {
    _isRendering = false;
  }
}


function patchRender(container, newHtml, opts = {}) {
  const scrollTop = container.scrollTop;
  const scrollLeft = container.scrollLeft;
  const useMorph = opts.morph !== false && typeof morphdom === 'function' && container.children.length > 0;

  if (useMorph) {
    const wrap = document.createElement('div');
    wrap.innerHTML = newHtml;
    morphdom(container, wrap, {
      childrenOnly: true,
      getNodeKey(node) {
        if (node && node.nodeType === 1) {
          // group 与 row 常共用同一 data-id，必须加前缀，否则 morphdom 键冲突
          if (node.classList && node.classList.contains('task-group') && node.dataset && node.dataset.id) {
            return 'g:' + node.dataset.id;
          }
          if (node.classList && node.classList.contains('task-row') && node.dataset && node.dataset.id) {
            return 'r:' + node.dataset.id;
          }
          if (node.dataset && node.dataset.id) return 'id:' + node.dataset.id;
          if (node.dataset && node.dataset.taskId) return 'tid:' + node.dataset.taskId;
        }
        return node.id || null;
      },
      onBeforeElUpdated(fromEl, toEl) {
        const active = document.activeElement;
        if (active && (fromEl === active || fromEl.contains(active))) return false;
        // 保留选中态 class（state 驱动的 selected 由 render 末尾补回）
        return true;
      }
    });
  } else {
    container.querySelectorAll('.selected, .multi-selected').forEach(el => {
      el.classList.remove('selected', 'multi-selected');
    });
    container.innerHTML = newHtml;
  }
  container.scrollTop = scrollTop;
  container.scrollLeft = scrollLeft;
}
window.ModuleApp._renderRoot = function(container, html, opts) { patchRender(container, html, opts); };

// ==================== 主控生命周期服务 ====================
const CoreServices = {

  async loadTasks() {
    const tasks = await _api.tasks.getAll();
    const State = window.ModuleApp.State;
    const PS = window.ModuleApp.ProjectScope;
    const prev = State.state.projectScopeIds || [];
    const scrubbed = PS ? PS.scrubScopeIds(tasks, prev) : prev;
    const scopeChanged = scrubbed.length !== prev.length || scrubbed.some((id, i) => id !== prev[i]);
    if (scopeChanged) {
      State.patch({ tasks, projectScopeIds: scrubbed });
      try { await _api.config.update({ projectScopeIds: scrubbed }); } catch (_) {}
    } else {
      State.patch({ tasks });
    }
    CoreServices.refreshProjectScopeSelect();
    const lastRead = localStorage.getItem('lastReadCompletedTime');
    const badge = document.getElementById('completedCount');
    if (badge) {
      const c = lastRead
        ? tasks.filter(t => t.completed && t.completedAt && t.completedAt > lastRead).length
        : 0;
      badge.textContent = c > 0 ? c : '';
    }
  },

  refreshProjectScopeSelect() {
    const sel = document.getElementById('projectScopeSelect');
    if (!sel) return;
    const State = window.ModuleApp.State;
    const PS = window.ModuleApp.ProjectScope;
    const roots = PS ? PS.listProjectRoots(State.state.tasks) : [];
    const cur = (State.state.projectScopeIds || [])[0] || '';
    sel.replaceChildren();
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = tr('common.allProjects', '全部项目');
    sel.appendChild(optAll);
    for (const t of roots) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.content || `(${tr('common.unknown', '未命名')})`;
      if (t.id === cur) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!roots.some(t => t.id === cur)) sel.value = '';
  },

  updateAddTaskBtnLabel() {
    const addBtn = document.getElementById('addTaskBtn');
    if (!addBtn) return;
    // 顶栏 + 只唤起底栏；落点由 hint 说明
    addBtn.textContent = tr('toolbar.addTask', '+ 添加');
    addBtn.title = tr('toolbar.addTask', '聚焦底栏快速添加（详细备注请编辑任务）');
  },

  /**
   * 切换项目作用域：条件清选中 + 持久化 + 刷新
   * @param {string[]} nextIds
   * @param {{ toast?: string }} [opts]
   */
  async setProjectScope(nextIds, opts = {}) {
    const State = window.ModuleApp.State;
    const PS = window.ModuleApp.ProjectScope;
    const ids = Array.isArray(nextIds) ? nextIds.filter(Boolean) : [];
    const scrubbed = PS ? PS.scrubScopeIds(State.state.tasks, ids) : ids;
    const vis = PS ? PS.visibleIdSet(State.state.tasks, scrubbed) : null;

    const patch = { projectScopeIds: scrubbed };
    if (vis) {
      if (State.state.selectedId && !vis.has(State.state.selectedId)) patch.selectedId = null;
      if (State.state.anchorId && !vis.has(State.state.anchorId)) patch.anchorId = null;
      if (State.state.multiSelect && State.state.multiSelect.size > 0) {
        const nextMulti = [...State.state.multiSelect].filter(id => vis.has(id));
        patch.multiSelect = nextMulti;
      }
    }
    State.patch(patch);
    try { await _api.config.update({ projectScopeIds: scrubbed }); } catch (_) {}
    CoreServices.refreshProjectScopeSelect();
    CoreServices.updateAddTaskBtnLabel();
    window.ModuleApp.TaskController?.updateQuickInputHint?.();
    if (State.state.multiSelect?.size === 0) window.ModuleApp.BatchBar?.update?.();
    CoreServices.render();
    if (opts.toast) window.ModuleApp.Toast?.show(opts.toast, 'info');
  },

  async loadNotes() {
    const notes = await _api.notes.list();
    window.ModuleApp.State.patch({ notes });
  },

  applyConfig(config) {
    if (!config) return;
    const patch = {};
    if (typeof config.autoPlan === 'boolean') {
      patch.autoPlan = config.autoPlan;
      document.getElementById('autoPlanBtn')?.classList.toggle('active', config.autoPlan);
    }
    if (Array.isArray(config.projectScopeIds)) patch.projectScopeIds = config.projectScopeIds;
    window.ModuleApp.State.patch(patch);
    if (config.theme === 'light' || config.theme === 'dark') {
      document.body.classList.toggle('theme-dark', config.theme === 'dark');
      localStorage.setItem('theme', config.theme);
      const button = document.getElementById('themeToggleBtn');
      if (button) button.textContent = config.theme === 'dark' ? `☀️ ${tr('toolbar.themeLight', '浅色')}` : `🌙 ${tr('toolbar.themeDark', '深色')}`;
    }
    this.refreshProjectScopeSelect();
    this.updateAddTaskBtnLabel();
  },

  refreshThemeToggleBtn() {
    const themeBtn = document.getElementById('themeToggleBtn');
    if (!themeBtn) return;
    const isDark = document.body.classList.contains('theme-dark');
    themeBtn.textContent = isDark ? `☀️ ${tr('toolbar.themeLight', '浅色')}` : `🌙 ${tr('toolbar.themeDark', '深色')}`;
    themeBtn.title = isDark ? tr('toolbar.themeLight', '切换浅色模式') : tr('toolbar.themeDark', '切换深色模式');
  },

  async refreshConfig() {
    const cfg = await _api.config.get();
    if (cfg && cfg.language !== undefined && window.ModuleApp.I18n && window.ModuleApp.I18n.getSetting() !== (cfg.language || 'auto')) {
      window.ModuleApp.I18n.setLocale(cfg.language || 'auto');
      this.updateViewHeader(window.ModuleApp.State.state.view);
      this.refreshThemeToggleBtn();
    }
    this.applyConfig(cfg);
  },

  async refreshUndoUI() {
    const list = await _api.undo.list();
    const can  = await _api.undo.canUndo();
    const btn  = document.getElementById('undoBtn');
    const hint = document.getElementById('undoHint');
    const lastLabel = list.length > 0 ? list[0].label : '';
    if (btn) {
      btn.disabled = !can;
      btn.title = can
        ? `${tr('toolbar.undoWithLabel', '撤回: {action}', { action: lastLabel })} (Ctrl+Z)`
        : tr('toast.undoEmpty', '没有可撤回的操作');
    }
    if (hint) hint.textContent = can ? `· ${lastLabel}` : '';
  },

  async performUndo() {
    const btn = document.getElementById('undoBtn');
    if (this._undoPending) return;
    if (btn && btn.disabled) { window.ModuleApp.Toast.show(tr('toast.undoEmpty', '没有可撤回的操作'), 'info'); return; }
    this._undoPending = true;
    if (btn) btn.disabled = true;
    try {
    const res = await _api.undo.undo();
    if (!res.ok) { window.ModuleApp.Toast.show(res.message || tr('toast.undoFailed', '撤回失败', { error: '' }), 'error'); return; }
    await this.refreshConfig();
    await this.loadTasks();
    await this.loadNotes();
    window.ModuleApp.TaskController.clearSelection();
    await this.render();
    window.ModuleApp.Toast.show(tr('toast.undoSuccess', '已撤回: {action}', { action: res.label }), 'success');
    } catch (error) {
      showDataError(error);
    } finally {
      this._undoPending = false;
      try { await this.refreshUndoUI(); } catch (error) { showDataError(error); }
    }
  },

  updateViewHeader(view) {
    const titles = {
      hierarchy:   [tr('hierarchy.title', '层级视图'),    tr('hierarchy.dragHint', '拖拽排序（拖到下方可左右调层级） · ↑↓ 选中 · Enter 编辑 · Space 完成 · / 搜索 · n 底栏添加')],
      deadline:    [tr('deadline.title', '截止日期'),     tr('deadline.title', '按截止日期排序 · ↑↓ 选中 · Enter 编辑 · Esc 关闭 · Space 完成 · n 底栏添加')],
      gantt:       [tr('gantt.title', '甘特图'),         tr('gantt.title', '任务时间线视图')],
      completed:   [tr('completed.title', '已完成项目'),  tr('completed.retentionHint', '超过保留天数的已完成项目可清理', { days: 180 })],
      reports:     [tr('reports.title', '周报'),         tr('reports.title', '每周自动统计已完成任务')],
      notes:       [tr('notes.title', '备忘录'),         tr('notes.title', '快速记录灵感与备忘')],
    };

    const titleEl = document.getElementById('viewTitle');
    const hintEl  = document.getElementById('viewHint');
    if (titleEl) titleEl.textContent = titles[view]?.[0] || '';
    if (hintEl)  hintEl.textContent  = titles[view]?.[1] || '';
  },

  switchView(view) {
    const State = window.ModuleApp.State;
    const s = State.state;
    if (s.view === 'notes') window.ModuleApp.NotesView.captureDrafts?.();
    if (s.view === 'reports' && view !== 'reports') window.ModuleApp.ReportsView.cancelRender?.();

    if (s.view === 'gantt' && view !== 'gantt') {
      if (window.ModuleApp.GanttView?.unmount) window.ModuleApp.GanttView.unmount();
    }

    State.patch({ view });

    document.querySelectorAll('.nav-item')
      .forEach(n => n.classList.toggle('active', n.dataset.view === view));

    const vc = document.getElementById('viewContainer');
    if (vc) vc.classList.toggle('view-gantt', view === 'gantt');

    if (view === 'completed') {
      localStorage.setItem('lastReadCompletedTime', new Date().toISOString());
      const badge = document.getElementById('completedCount');
      if (badge) badge.textContent = '';
    }

    this.updateViewHeader(view);

    const addBtn = document.getElementById('addTaskBtn');
    if (addBtn) {
      addBtn.style.display = (view === 'hierarchy' || view === 'deadline') ? '' : 'none';
      CoreServices.updateAddTaskBtnLabel();
    }

    const qi = document.querySelector('.quick-input');
    if (qi) qi.style.display = (view === 'hierarchy' || view === 'deadline') ? '' : 'none';

    State.patch({ editingNoteId: null });
    window.ModuleApp.TaskController.clearSelection();
    this.render();

    // 记住上次视图（启动恢复）
    const allowed = window.ModuleApp.Constants?.VIEWS
      ? Object.values(window.ModuleApp.Constants.VIEWS) : null;
    if (!allowed || allowed.includes(view)) {
      _api.config.update({ lastView: view }).catch(() => {});
    }
  },

  async render() {
    const s = window.ModuleApp.State.state;
    const renderedView = s.view;
    if (s.view === 'reports' && document.activeElement?.id?.startsWith('reportNotesInput_')) return;

    switch (s.view) {
      case 'hierarchy':  window.ModuleApp.HierarchyView.render(s, 'REPLACE'); break;
      case 'deadline':  window.ModuleApp.DeadlineView.render(s);             break;
      case 'gantt':     window.ModuleApp.GanttView.render();                 break;
      case 'completed': window.ModuleApp.CompletedView.render(s);            break;
      case 'reports':   await window.ModuleApp.ReportsView.render(s);        break;
      case 'notes':     window.ModuleApp.NotesView.render(s, 'REPLACE');     break;
    }

    if (s.view !== renderedView) return;
    if (s.multiSelect?.size > 0) window.ModuleApp.BatchBar.update();

    const selEl = document.querySelector(`.task-row[data-id="${s.selectedId}"]`);
    if (s.selectedId && !selEl) window.ModuleApp.TaskController.clearSelection();
    else if (selEl) selEl.classList.add('selected');

    window.ModuleApp.TaskController.updateQuickInputHint();
    window.ModuleApp.SearchController.updateSearchResult();

    // 侧边栏统计面板（跟当前项目作用域）
    const PS = window.ModuleApp.ProjectScope;
    const DB = window.ModuleApp.DeadlineBuckets;
    const scopedTasks = PS
      ? PS.filterTasksByProjectScope(s.tasks, s.projectScopeIds)
      : s.tasks;
    const active = scopedTasks.filter(t => !t.completed);
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    document.getElementById('statActive').textContent  = active.length;
    const nearEl = document.getElementById('statNear');
    if (nearEl) {
      nearEl.textContent = DB ? DB.countNearTwoDays(scopedTasks) : '0';
    }
    document.getElementById('statOverdue').textContent = DB
      ? DB.countOverdue(scopedTasks)
      : active.filter(t => {
          if (!t.deadline) return false;
          const [y, m, d] = t.deadline.split('-').map(Number);
          return new Date(y, m - 1, d) < today;
        }).length;
    document.getElementById('statDone').textContent
      = scopedTasks.filter(t => t.completedAt && new Date(t.completedAt) >= today).length;
  }
};

window.ModuleApp.setProjectScope = CoreServices.setProjectScope.bind(CoreServices);
window.ModuleApp.refreshUndoUI = CoreServices.refreshUndoUI.bind(CoreServices);

function _formatBackupKindLabel(kind) {
  if (kind === 'daily') return tr('common.refresh', '每日');
  if (kind === 'pre-import') return tr('common.import', '导入前');
  if (kind === 'pre-restore') return tr('common.restore', '恢复前');
  return kind || tr('toolbar.backup', '备份');
}

async function refreshBackupsList() {
  const listEl = document.getElementById('backupList');
  if (!listEl) return;
  if (!_api.backups?.list) {
    listEl.replaceChildren();
    const hint = document.createElement('div');
    hint.className = 'data-hint';
    hint.textContent = tr('modal.backupEmpty', '当前运行模式不支持自动备份列表');
    listEl.appendChild(hint);
    return;
  }
  listEl.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'data-hint';
  loading.textContent = tr('common.loading', '正在加载备份列表...');
  listEl.appendChild(loading);
  try {
    const items = await _api.backups.list();
    listEl.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'data-hint';
      empty.textContent = tr('modal.backupEmpty', '暂无自动备份');
      listEl.appendChild(empty);
      return;
    }
    for (const b of items) {
      const row = document.createElement('div');
      row.className = 'backup-item';

      const meta = document.createElement('div');
      meta.className = 'backup-meta';

      const titleRow = document.createElement('div');
      titleRow.className = 'backup-title-row';

      const badge = document.createElement('span');
      badge.className = 'backup-kind-badge';
      badge.textContent = _formatBackupKindLabel(b.kind);

      const timeEl = document.createElement('span');
      timeEl.textContent = b.createdAt || b.id;

      titleRow.appendChild(badge);
      titleRow.appendChild(timeEl);

      const sub = document.createElement('div');
      sub.className = 'backup-sub';
      sub.textContent = `${b.taskCount ?? 0} ${tr('nav.statsTotal', '任务')} · ${b.noteCount ?? 0} ${tr('nav.notes', '便签')} · ${b.reportCount ?? 0} ${tr('nav.reports', '周报')}`;

      meta.appendChild(titleRow);
      meta.appendChild(sub);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm';
      btn.textContent = tr('common.restore', '恢复');
      btn.dataset.backupId = b.id;

      row.appendChild(meta);
      row.appendChild(btn);
      listEl.appendChild(row);
    }
  } catch (err) {
    listEl.replaceChildren();
    const errEl = document.createElement('div');
    errEl.className = 'data-hint';
    errEl.textContent = tr('toast.loadFailed', '加载备份失败: {error}', { error: err?.message || err });
    listEl.appendChild(errEl);
  }
}

window.ModuleApp.refreshBackupsList = refreshBackupsList;

function bindEarlyDataUI() {
  if (_earlyDataUIBound) return;
  _earlyDataUIBound = true;

  // 顶栏「更多」菜单与数据备份恢复入口必须在 config.get() 之前绑定，确保主库损坏时仍可用
  const moreBtn = document.getElementById('moreMenuBtn');
  const moreMenu = document.getElementById('moreMenu');
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moreMenu.hidden = !moreMenu.hidden;
    });
    document.addEventListener('click', () => { moreMenu.hidden = true; });
    moreMenu.addEventListener('click', (e) => e.stopPropagation());
  }

  document.getElementById('dataMenuBtn')?.addEventListener('click', async () => {
    let dbPath = '';
    try { dbPath = await _api.debug.dataPath(); } catch (_) {}
    window.ModuleApp.Modal.showDataModal(dbPath);
  });

  document.getElementById('refreshBackupsBtn')?.addEventListener('click', () => {
    refreshBackupsList();
  });

  document.getElementById('backupList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-backup-id]');
    if (!btn || !_api.backups?.restore) return;
    const backupId = btn.dataset.backupId;
    if (!backupId) return;
    const ok = await window.ModuleApp.Modal.confirm({
      title: tr('modal.confirmTitle', '确认恢复自动备份'),
      message: tr('modal.backupRestoreConfirm', `确定从备份「${backupId}」恢复数据吗？恢复前会自动保存当前有效数据或损坏文件诊断副本。`),
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      const res = await _api.backups.restore(backupId);
      const dataModal = document.getElementById('dataModal');
      if (dataModal) dataModal.hidden = true;
      if (!_initCompleted) {
        window.ModuleApp.Toast?.show(tr('modal.backupRestoreSuccess', '已从备份恢复，正在重新加载界面...'), 'success');
        window.location.reload();
        return;
      }
      await CoreServices.refreshConfig();
      await CoreServices.loadTasks();
      await CoreServices.loadNotes();
      await safeRender();
      await CoreServices.refreshUndoUI();
      window.ModuleApp.Toast?.show(tr('modal.backupRestoreSuccess', `已恢复 ${res?.taskCount ?? 0} 条任务`), 'success');
    } catch (err) {
      window.ModuleApp.Toast?.show(tr('toast.loadFailed', '恢复备份失败: {error}', { error: err?.message || err }), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('exportJsonBtn')?.addEventListener('click', async () => {
    const result = await _api.data.export();
    if (result.ok) window.ModuleApp.Toast.show(tr('modal.backupExportSuccess', `已成功导出 ${result.tasks} 个项目`), 'success');
  });

  document.getElementById('importJsonBtn')?.addEventListener('click', async () => {
    const fileResult = await _api.data.readFile();
    if (fileResult?.canceled) return;
    if (!fileResult?.ok) return window.ModuleApp.Toast.show(tr('toast.loadFailed', '读取文件失败', { error: '' }), 'error');
    const choice = await window.ModuleApp.Modal.choose({
      title: tr('modal.confirmTitle', '确认导入方式'),
      message: tr('modal.backupImportConfirm', `检测到 ${fileResult.taskCount} 个任务。请选择导入方式：`),
      choices: [
        { id: 'replace', label: tr('modal.importModeOverwrite', '覆盖现有数据'), primary: true },
        { id: 'merge', label: tr('modal.importModeMerge', '合并（按 id）') },
        { id: 'cancel', label: tr('common.cancel', '取消') },
      ]
    });
    if (!choice || choice === 'cancel') return;
    try {
      await _api.data.import(fileResult.snapshot, choice === 'replace' ? 'replace' : 'merge');
      if (!_initCompleted) {
        window.location.reload();
        return;
      }
      await CoreServices.refreshConfig();
      await CoreServices.loadTasks();
      await CoreServices.loadNotes();
      CoreServices.render();
      await CoreServices.refreshUndoUI();
      document.getElementById('dataModal').hidden = true;
      window.ModuleApp.Toast.show(tr('modal.backupImportSuccess', '导入完成'), 'success');
    } catch(e) { window.ModuleApp.Toast.show(tr('toast.loadFailed', '导入失败: {error}', { error: e.message }), 'error'); }
  });
}

// ==================== 依赖注入与核心初始化 ====================
async function init() {
  const State = window.ModuleApp.State;

  // 1. 初始化原子组件与数据恢复 UI（必须在读取主库之前就绪，保证损坏启动时可恢复）
  window.ModuleApp.Modal.init();
  bindEarlyDataUI();
  window.ModuleApp.DatePicker.init(State);
  window.ModuleApp.ContextMenu.init(State,
    (action, val, id) => window.ModuleApp.TaskController.handleContextAction(action, val, id));
  window.ModuleApp.BatchBar.init(State,
    (action, ids) => window.ModuleApp.TaskController.handleBatchAction(action, ids));

  // 2. 初始化高敏业务控制器并注入核心依赖回调
  window.ModuleApp.TaskController.init(State, {
    loadTasks:     CoreServices.loadTasks.bind(CoreServices),
    render:        CoreServices.render.bind(CoreServices),
    refreshUndoUI:  CoreServices.refreshUndoUI.bind(CoreServices),
  });
  window.ModuleApp.DragController.init(State, {
    loadTasks:     CoreServices.loadTasks.bind(CoreServices),
    loadNotes:     CoreServices.loadNotes.bind(CoreServices),
    render:        CoreServices.render.bind(CoreServices),
    refreshUndoUI: CoreServices.refreshUndoUI.bind(CoreServices),
  });
  window.ModuleApp.SearchController.init(State, {
    render:     CoreServices.render.bind(CoreServices),
    switchView: CoreServices.switchView.bind(CoreServices),
  });
  window.ModuleApp.KeyboardController.init(State, {
    render: CoreServices.render.bind(CoreServices),
  });

  // State.subscribe：对端 Delta 合并后统一走 PEER_DELTA → safeRender（避免假 pub/sub）
  State.subscribe((_s, actionType) => {
    if (actionType === 'PEER_DELTA') safeRender();
    if (actionType === 'CONFIG_UPDATED' && _s) {
      // theme 由 onDataChange 显式处理
    }
  });

  // 3. 挂载视图容器（让各视图的 _container 指向 #viewContainer）
  const viewContainer = document.getElementById('viewContainer');
  window.ModuleApp.HierarchyView.mount?.(viewContainer);
  window.ModuleApp.DeadlineView.mount?.(viewContainer);
  window.ModuleApp.CompletedView.mount?.(viewContainer);
  window.ModuleApp.NotesView.mount?.(viewContainer);
  window.ModuleApp.ReportsView.mount?.(viewContainer);

  // 4. 基础主题设置与导航侦听（主题以上端 config 为准，localStorage 作冷启动兜底）
  function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('theme-dark', isDark);
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
      themeBtn.textContent = isDark ? `☀️ ${tr('toolbar.themeLight', '浅色')}` : `🌙 ${tr('toolbar.themeDark', '深色')}`;
      themeBtn.title = isDark ? tr('toolbar.themeLight', '切换浅色模式') : tr('toolbar.themeDark', '切换深色模式');
    }
  }

  let bootTheme = localStorage.getItem('theme') || 'light';
  let cfg0 = null;
  try {
    cfg0 = await _api.config.get();
    if (cfg0 && (cfg0.theme === 'light' || cfg0.theme === 'dark')) bootTheme = cfg0.theme;
  } catch (_) {}
  if (window.ModuleApp.I18n) {
    window.ModuleApp.I18n.setLocale((cfg0 && cfg0.language) || 'auto');
  }
  applyTheme(bootTheme);
  localStorage.setItem('theme', bootTheme);

  document.getElementById('themeToggleBtn')?.addEventListener('click', async () => {
    const next = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('theme', next);
    try { await _api.config.update({ theme: next }); } catch (_) {}
  });

  document.querySelectorAll('.nav-item')
    .forEach(n => n.addEventListener('click', () => CoreServices.switchView(n.dataset.view)));

  document.getElementById('sidebarSettingsBtn')?.addEventListener('click', () => {
    window.api?.app?.openSettings?.();
  });

  // 顶栏 +：聚焦底栏快建（弹窗仅编辑详情）
  document.getElementById('addTaskBtn')?.addEventListener('click', () => {
    window.ModuleApp.TaskController.focusQuickCreate({ asRoot: true });
  });
  document.getElementById('saveTaskBtn')?.addEventListener('click',
    () => window.ModuleApp.TaskController.saveTask());

  // 5. 自动规划 / 项目作用域 / 上次视图
  let initialView = 'hierarchy';
  try {
    const cfg = await _api.config.get();
    const autoPlan = cfg ? !!cfg.autoPlan : false;
    const projectScopeIds = Array.isArray(cfg?.projectScopeIds) ? cfg.projectScopeIds : [];
    State.patch({ autoPlan, projectScopeIds });
    document.getElementById('autoPlanBtn')?.classList.toggle('active', autoPlan);
    const views = window.ModuleApp.Constants?.VIEWS
      ? Object.values(window.ModuleApp.Constants.VIEWS) : [];
    if (cfg?.lastView && views.includes(cfg.lastView)) initialView = cfg.lastView;
  } catch(e) {}

  document.getElementById('autoPlanBtn')?.addEventListener('click', () => {
    const ns = !State.state.autoPlan;
    State.patch({ autoPlan: ns });
    document.getElementById('autoPlanBtn')?.classList.toggle('active', ns);
    _api.config.update({ autoPlan: ns });
    window.ModuleApp.Toast.show(
      ns ? tr('toolbar.autoPlanOn', '已开启：母任务时间跟随子任务') : tr('toolbar.autoPlanOff', '已关闭：母任务时间不再自动跟随'),
      'success'
    );
  });

  document.getElementById('projectScopeSelect')?.addEventListener('change', (e) => {
    const v = e.target.value || '';
    CoreServices.setProjectScope(v ? [v] : []);
  });

  const wBtn = document.getElementById('widgetToggleBtn');
  if (wBtn) {
    _api.widget.status().then(s => wBtn.classList.toggle('active', s.open)).catch(() => {});
    wBtn.addEventListener('click', async () => {
      const res = await _api.widget.toggle();
      wBtn.classList.toggle('active', res.open);
      moreMenu && (moreMenu.hidden = true);
    });
  }

  // 6. 全局撤销监听与快捷键
  document.getElementById('undoBtn')?.addEventListener('click', () => CoreServices.performUndo());
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
      e.preventDefault();
      CoreServices.performUndo();
    }
  });

  // 7. 清理入口
  document.getElementById('cleanupBtn')?.addEventListener('click', async () => {
    let days = 180;
    try { const c = await _api.config.get(); days = c.taskRetentionDays || 180; } catch(_) {}
    if (await window.ModuleApp.Modal.confirm({ title: tr('toolbar.cleanup', '清理'), message: tr('completed.cleanupConfirm', '确定清理 {days} 天前已完成的任务吗？', { days }) })) {
      const res = await _api.tasks.cleanup();
      window.ModuleApp.Toast.show(tr('completed.cleanupSuccess', '已清理 {count} 项', { count: res.removed }), 'success');
      await CoreServices.loadTasks();
      CoreServices.render();
      CoreServices.refreshUndoUI();
    }
  });

  // 7. 引导加载及视图呈现
  await CoreServices.refreshUndoUI();
  await CoreServices.loadTasks();
  await CoreServices.loadNotes();
  try {
    const ver = await _api.app.version();
    const el = document.getElementById('appVersion');
    if (el && ver) el.textContent = '· v' + ver;
  } catch (_) {}
  CoreServices.switchView(initialView);
  scheduleMidnightRefresh();

  // 侧栏：近两日 / 已延期 → 提醒列表窗（跟当前 scope；不写 lastDailyReminderDate）
  const openStatPanel = (mode) => {
    if (!_api.reminder?.openPanel) return;
    _api.reminder.openPanel({ mode, useScope: true });
  };
  const bindStatClick = (el, mode) => {
    if (!el) return;
    el.addEventListener('click', () => openStatPanel(mode));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openStatPanel(mode);
      }
    });
  };
  bindStatClick(document.getElementById('statNearItem'), 'near');
  bindStatClick(document.getElementById('statOverdueItem'), 'overdue');

  // 提醒窗点任务 → 层级视图定位（展开祖先；提醒窗保持打开）
  if (_api.onReminderNavigate) {
    _api.onReminderNavigate(async (id) => {
      if (!id) return;
      const State = window.ModuleApp.State;
      const PS = window.ModuleApp.ProjectScope;
      const scopeIds = State.state.projectScopeIds || [];
      // 定时提醒是全局列表；若当前项目过滤会藏掉目标，先切回全部再定位
      if (scopeIds.length > 0 && PS && !PS.isTaskInScope(State.state.tasks, scopeIds, id)) {
        if (typeof window.ModuleApp.setProjectScope === 'function') {
          await window.ModuleApp.setProjectScope([], { toast: tr('common.allProjects', '已切回全部项目以定位该任务') });
        }
      }
      const Sc = window.ModuleApp.SearchController;
      if (Sc && typeof Sc.jumpToSearchHit === 'function') {
        // 复用搜索跳转：切层级 + 展开折叠祖先 + 滚入
        Sc.jumpToSearchHit(id, { keepSearch: true, toast: false });
      } else {
        CoreServices.switchView('hierarchy');
      }
      requestAnimationFrame(() => {
        window.ModuleApp.TaskController?.selectTask?.(id);
        const row = document.querySelector(`.task-row[data-id="${id}"]`);
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  // 8. 视域切入焦点防护（含跨天懒加载）
  let lastRenderDateStr = new Date().toDateString();
  window.addEventListener('focus', () => {
    const todayStr = new Date().toDateString();
    if (todayStr !== lastRenderDateStr) {
      lastRenderDateStr = todayStr;
      const a = document.activeElement;
      const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
      if (!typing) {
        CoreServices.loadTasks().then(() => CoreServices.render());
      }
    }
  });
  await cleanupAndRefresh();
  _initCompleted = true;
}

async function cleanupAndRefresh() {
  try {
    const result = await _api.tasks.cleanup();
    if (result.removed > 0) {
      await CoreServices.loadTasks();
      await safeRender();
      await CoreServices.refreshUndoUI();
    }
  } catch (error) {
    showDataError(error);
  }
}

function showDataError(error) {
  window.ModuleApp.Toast?.show(tr('toast.loadFailed', '数据操作失败: {error}', { error: error?.message || error }), 'error');
}

function startApp() {
  init().catch(error => {
    showDataError(error);
    const container = document.getElementById('viewContainer');
    if (!container) return;
    const message = document.createElement('div');
    message.className = 'empty-state';
    message.setAttribute('role', 'alert');
    message.textContent = tr('toast.loadFailed', '无法读取任务数据，原文件已保留。请修复文件或恢复备份后重启程序。\n{error}', { error: error?.message || error });
    container.replaceChildren(message);
    if (typeof window !== 'undefined' && typeof container.appendChild === 'function') {
      const recoverBtn = document.createElement('button');
      recoverBtn.type = 'button';
      recoverBtn.className = 'btn btn-primary';
      recoverBtn.style.marginTop = '12px';
      recoverBtn.textContent = `📦 ${tr('common.restore', '从自动备份恢复')}`;
      recoverBtn.addEventListener('click', async () => {
        let dbPath = '';
        try { dbPath = await window.api?.debug?.dataPath?.(); } catch (_) {}
        window.ModuleApp?.Modal?.showDataModal?.(dbPath);
      });
      message.appendChild?.(document.createElement('br'));
      message.appendChild?.(recoverBtn);
    }
  });
}

// 零点同步调度：跨天状态纠偏
function scheduleMidnightRefresh() {
  const now      = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = tomorrow.getTime() - now.getTime() + 1000;
  setTimeout(async () => {
    const activeEl = document.activeElement;
    const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
    if (!isTyping) {
      await CoreServices.loadTasks();
      CoreServices.render();
    }
    scheduleMidnightRefresh();
  }, msUntilMidnight);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp);
else startApp();

// ==================== Delta Sync 实时增量广播接收器 ====================
// 契约：本窗写操作不靠广播自刷（主进程跳过 exceptSender）；
// 这里只处理对端（桌面组件 / 设置窗）写入后的同步。
function applyPeerDelta(patch) {
  const State = window.ModuleApp.State;
  const tasks = State.state.tasks;
  const markCompleted = (ids, done) => {
    const set = new Set(ids);
    const now = new Date().toISOString();
    return tasks.map(t => {
      if (!set.has(t.id)) return t;
      return done
        ? { ...t, completed: true, completedAt: t.completedAt || now }
        : { ...t, completed: false, completedAt: null };
    });
  };

  switch (patch.action) {
    case 'TASK_CREATED': {
      if (patch.payload && patch.payload.id) {
        State.patch({ tasks: [...tasks, patch.payload] }, 'PEER_DELTA');
        return true;
      }
      return false;
    }
    case 'TASKS_BATCH_CREATED': {
      if (Array.isArray(patch.payload) && patch.payload.length) {
        State.patch({ tasks: [...tasks, ...patch.payload] }, 'PEER_DELTA');
        return true;
      }
      return false;
    }
    case 'TASK_UPDATED': {
      if (!patch.id || !patch.payload) return false;
      State.patch({
        tasks: tasks.map(t => t.id === patch.id ? { ...t, ...patch.payload } : t)
      }, 'PEER_DELTA');
      return true;
    }
    case 'TASK_DELETED':
    case 'TASKS_CLEANED': {
      const ids = new Set(patch.ids || (patch.id ? [patch.id] : []));
      if (patch.payload && Array.isArray(patch.payload.deleted)) {
        for (const id of patch.payload.deleted) ids.add(id);
      }
      let next = tasks.filter(t => !ids.has(t.id));
      const promotedTasks = patch.payload && Array.isArray(patch.payload.promotedTasks)
        ? patch.payload.promotedTasks : [];
      if (promotedTasks.length) {
        const map = new Map(promotedTasks.map(p => [p.id, p]));
        next = next.map(t => (map.has(t.id) ? { ...t, ...map.get(t.id) } : t));
      }
      State.patch({ tasks: next }, 'PEER_DELTA');
      return true;
    }
    case 'TASKS_BATCH_DELETED': {
      const ids = new Set(patch.ids || []);
      if (patch.payload && Array.isArray(patch.payload.deleted)) {
        for (const id of patch.payload.deleted) ids.add(id);
      }
      let next = tasks.filter(t => !ids.has(t.id));
      const promotedTasks = patch.payload && Array.isArray(patch.payload.promotedTasks)
        ? patch.payload.promotedTasks : [];
      if (promotedTasks.length) {
        const map = new Map(promotedTasks.map(p => [p.id, p]));
        next = next.map(t => (map.has(t.id) ? { ...t, ...map.get(t.id) } : t));
      }
      State.patch({ tasks: next }, 'PEER_DELTA');
      return true;
    }
    case 'TASK_COMPLETED': {
      const ids = (patch.payload && patch.payload.ids) || (patch.id ? [patch.id] : []);
      State.patch({ tasks: markCompleted(ids, true) }, 'PEER_DELTA');
      return true;
    }
    case 'TASK_UNCOMPLETED': {
      const p = patch.payload && typeof patch.payload === 'object' ? patch.payload : null;
      State.patch({
        tasks: tasks.map(t => {
          if (t.id !== patch.id) return t;
          if (p) return { ...t, ...p, completed: false, completedAt: null };
          return { ...t, completed: false, completedAt: null };
        })
      }, 'PEER_DELTA');
      return true;
    }
    case 'TASKS_BATCH_COMPLETED': {
      const ids = Array.isArray(patch.payload?.completed)
        ? patch.payload.completed.map(task => task.id) : (patch.ids || []);
      State.patch({ tasks: markCompleted(ids, true) }, 'PEER_DELTA');
      return true;
    }
    case 'TASKS_BATCH_UNCOMPLETED': {
      const byId = new Map(
        (patch.payload && Array.isArray(patch.payload.tasks) ? patch.payload.tasks : [])
          .map(t => [t.id, t])
      );
      const idSet = new Set(patch.ids || []);
      State.patch({
        tasks: tasks.map(t => {
          if (!idSet.has(t.id) && !byId.has(t.id)) return t;
          const p = byId.get(t.id);
          if (p) return { ...t, ...p, completed: false, completedAt: null };
          return { ...t, completed: false, completedAt: null };
        })
      }, 'PEER_DELTA');
      return true;
    }
    case 'TASKS_BATCH_PRIORITY': {
      const ids = new Set(patch.ids || []);
      const pri = patch.payload ? patch.payload.priority : null;
      State.patch({
        tasks: tasks.map(t => ids.has(t.id) ? { ...t, priority: pri || null } : t)
      }, 'PEER_DELTA');
      return true;
    }
    default:
      return false;
  }
}

_api.onDataChange(async (data) => {
  try {
  const patch = data && data.patch;
  if (!patch) {
    await CoreServices.loadTasks();
    await CoreServices.loadNotes();
    await CoreServices.render();
    return;
  }
  await CoreServices.refreshUndoUI();
  if (patch.reloadTasks) {
    await CoreServices.loadTasks();
    await safeRender();
    return;
  }
  if (patch.action === 'CONFIG_UPDATED') {
    if (patch.payload && patch.payload.language !== undefined && window.ModuleApp.I18n) {
      window.ModuleApp.I18n.setLocale(patch.payload.language || 'auto');
      CoreServices.updateViewHeader(window.ModuleApp.State.state.view);
      CoreServices.refreshThemeToggleBtn();
    }
    CoreServices.applyConfig(patch.payload);
    CoreServices.refreshProjectScopeSelect();
    await CoreServices.refreshUndoUI();
    await safeRender();
    return;
  }
  switch (patch.action) {
    case 'NOTE_CREATED': case 'NOTE_UPDATED': case 'NOTE_DELETED': case 'NOTES_REORDERED':
    case 'NOTES_FILTER':
      await CoreServices.loadNotes();
      safeRender();
      break;
    case 'DATA_UNDO': case 'DATA_IMPORTED': case 'EXTERNAL_DATA_CHANGED':
      if (typeof _initCompleted !== 'undefined' && !_initCompleted && typeof window !== 'undefined' && window.location?.reload) {
        window.location.reload();
        return;
      }
      await CoreServices.refreshConfig();
      await CoreServices.loadTasks();
      await CoreServices.loadNotes();
      await safeRender();
      break;
    case 'TASK_REORDERED':
    case 'REPORT_CREATED': case 'REPORT_DELETED': case 'REPORT_UPDATED':
      await CoreServices.loadTasks();
      await CoreServices.loadNotes();
      safeRender();
      break;
    default: {
      if (!applyPeerDelta(patch)) {
        await CoreServices.loadTasks();
        safeRender();
      }
      // PEER_DELTA 已由 subscribe → safeRender
      break;
    }
  }
  } catch (error) {
    showDataError(error);
  }
});
