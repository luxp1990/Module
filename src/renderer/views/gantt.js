// Module — 视图：甘特图（完全独立解耦版）
(function() {
  const _api = window.api;

  // 视图私有状态（从旧 app.js 迁移进来，实现自给自足）
  const ganttViewState = {
    _renderId: 0,
    centerDate: null,
    zoomLevel: 1,
    selectedTaskId: null,
    presetMode: null
  };

  const _gvs = () => ganttViewState;
  const _L = (zh, en) => (window.ModuleApp?.I18n?.getLocale?.() === 'en-US' ? en : zh);

  const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2];
  const DEFAULT_ZOOM_INDEX = 2;
  const MAX_GANTT_DAYS = 1095;
  const DEFAULT_GANTT_RANGE = 91;  // 导航时的默认时间跨度（≈ 3 个月）

  // ==================== 公开 API ====================

  const GanttView = {
    _container: null,

    mount(container) {
      this._container = container;
      this._bindEvents();  // 容器级事件委托，只绑一次
      _isActive = true;     // 允许键盘事件
    },

    unmount() {
      ganttViewState._renderId++; // 使在途异步请求失效，防止导航后覆盖新视图
      _isActive = false;    // 关闭键盘事件
      _hideTooltip();        // 清理 tooltip
      document.removeEventListener('keydown', _handleGanttKeys);
      document.querySelectorAll('.gantt-tooltip').forEach(el => el.remove());
      _activeTip = null;  // Bug-B 修复：防止 _positionTip 操作已移除的 DOM 节点
      this._container = null;
    },

    changeZoom(delta) {
      const gvs = _gvs();
      const currentIndex = ZOOM_LEVELS.indexOf(gvs.zoomLevel);
      if (currentIndex === -1) gvs.zoomLevel = ZOOM_LEVELS[DEFAULT_ZOOM_INDEX];  // 防御: zoomLevel 异常时重置
      const newIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, (ZOOM_LEVELS.indexOf(gvs.zoomLevel)) + delta));
      gvs.zoomLevel = ZOOM_LEVELS[newIndex];
      this.render();
      const lvl = document.getElementById('ganttZoomLevel');
      if (lvl) lvl.textContent = Math.round(gvs.zoomLevel * 100) + '%';
    },

    async render() {
      const container = this._container || document.getElementById('viewContainer');
      if (!container) return;

      const gvs = _gvs();
      const reqId = ++gvs._renderId;
      const isStale = () => {
        const curState = window.ModuleApp.State?.state;
        if (reqId !== gvs._renderId) return true;
        if (curState?.view && curState.view !== 'gantt') return true;
        return false;
      };

      document.querySelectorAll('.gantt-tooltip').forEach(el => el.remove());
      _activeTip = null;  // Bug-B 修复：渲染前清空状态，防止 mousemove 触发 _positionTip 访问已移除节点

      try {
        const data = await _api.gantt.data();
        if (isStale()) return;
        if (!data || data.length === 0) {
          const I18n = window.ModuleApp?.I18n;
          container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📊</div><div class="empty-state-title">${I18n?.t('gantt.empty') || '没有可显示的任务'}</div><div class="empty-state-hint">${_L('新建任务后即可在甘特图中查看', 'Create a task to view it on the Gantt chart')}</div></div>`;
          return;
        }

        const state = window.ModuleApp.State.state;
        const now = new Date(); now.setHours(0, 0, 0, 0);
        const dayWidth = 28 * gvs.zoomLevel;
        const PS = window.ModuleApp.ProjectScope;
        const vis = PS ? PS.visibleIdSet(state.tasks, state.projectScopeIds) : null;
        let tasks = data.filter(t => t.content);
        if (vis) tasks = tasks.filter(t => vis.has(t.id));
        if (tasks.length === 0) {
          const I18n = window.ModuleApp?.I18n;
          container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📊</div><div class="empty-state-title">${I18n?.t('hierarchy.emptyFiltered') || '该项目下没有可显示的任务'}</div><div class="empty-state-hint">${_L('切换「全部项目」或新建任务', 'Switch to "All Projects" or create a task')}</div></div>`;
          return;
        }

        // 日期范围计算
        // 有预设模式（presetMode / centerDate）→ 目标日期作为 minDate 紧贴任务名称栏左侧，向前展开 DEFAULT_GANTT_RANGE 天
        // 无预设模式 → 从任务数据计算（含熔断：范围 < 90 天时自动扩展到 90 天）
        let minDate, maxDate, totalDays;
        if (gvs.presetMode || gvs.centerDate) {
          const anchor = gvs.centerDate ? new Date(gvs.centerDate) : new Date(now);
          // 锚点设为 minDate（左侧对齐任务名称栏）
          minDate = new Date(anchor);
          minDate.setHours(0, 0, 0, 0);
          maxDate = new Date(minDate.getTime() + (DEFAULT_GANTT_RANGE - 1) * 86400000);
          totalDays = DEFAULT_GANTT_RANGE;
        } else {
          const taskDates = [];
          for (let ti = 0; ti < tasks.length; ti++) {
            if (tasks[ti].start) { const sd = _parseLocalDate(tasks[ti].start); if (sd && sd.getFullYear() >= 2000 && sd.getFullYear() <= 2050) taskDates.push(sd); }
            if (tasks[ti].end) { const ed = _parseLocalDate(tasks[ti].end); if (ed && ed.getFullYear() >= 2000 && ed.getFullYear() <= 2050) taskDates.push(ed); }
          }
          if (taskDates.length === 0) taskDates.push(new Date(now));
          let minTaskDate = new Date(Math.min.apply(null, taskDates));
          let maxTaskDate = new Date(Math.max.apply(null, taskDates));
          minTaskDate.setDate(minTaskDate.getDate() - 7);
          maxTaskDate.setDate(maxTaskDate.getDate() + 7);
          if (now < minTaskDate) minTaskDate = new Date(now);
          if (now > maxTaskDate) maxTaskDate = new Date(now);
          const minSpan = 90 * 86400000;
          if ((maxTaskDate - minTaskDate) < minSpan) {
            const centerTmp = new Date((minTaskDate.getTime() + maxTaskDate.getTime()) / 2);
            minTaskDate = new Date(centerTmp.getTime() - minSpan / 2);
            maxTaskDate = new Date(centerTmp.getTime() + minSpan / 2);
          }
          minDate = minTaskDate; maxDate = maxTaskDate;
          totalDays = Math.ceil((maxDate - minDate) / 86400000) + 1;
          if (totalDays > MAX_GANTT_DAYS) {
            totalDays = MAX_GANTT_DAYS;
            const todayMs = now.getTime();
            const half = Math.floor(MAX_GANTT_DAYS / 2) * 86400000;
            minDate = new Date(todayMs - half);
            maxDate = new Date(todayMs + half);
          }
        }

        // 写入当前渲染上下文，供 _getMinDate() 等函数读取
        _renderCtx.minDate   = new Date(minDate);
        _renderCtx.totalDays = totalDays;
        _renderCtx.dayWidth  = dayWidth;



        // 折叠过滤
        const hasGanttChildren = {};
        for (let j = 0; j < tasks.length; j++) {
          if (tasks[j].parentId) hasGanttChildren[tasks[j].parentId] = true;
        }

        const _isAncestorCollapsed = (task) => {
          // 修复 P2-9：之前从 window.ModuleApp.State.state.tasks 查（包含已完成），
          // 会让 gantt 自己的 data 树结构对不齐。改用本地 gantt tasks 构建 parentId 索引。
          const visited = new Set();
          let pid = task.parentId;
          while (pid && !visited.has(pid)) {
            visited.add(pid);
            if (state.collapsed.has(pid)) return true;
            const parent = tasks.find(t => t.id === pid);
            pid = parent ? parent.parentId : null;
          }
          return false;
        };

        const visibleTasks = tasks.filter(t => !_isAncestorCollapsed(t));

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const todayDay = Math.round((today - minDate) / 86400000);
        const todayColLeft = todayDay * dayWidth;
        const showTodayLine = todayDay >= 0 && todayDay <= totalDays;

        const ganttOffsetPx = -((minDate.getDay() + 6) % 7) * dayWidth;
        const ganttWeekPx = 7 * dayWidth;

        const rows = visibleTasks.map(t => _makeGanttRow(t, minDate, totalDays, dayWidth, today, todayDay, todayColLeft, showTodayLine, ganttOffsetPx, ganttWeekPx, hasGanttChildren)).join('');
        const headerHTML = _generateGanttHeader(minDate, totalDays, dayWidth, todayDay, showTodayLine, todayColLeft, ganttOffsetPx, ganttWeekPx);

        const I18n = window.ModuleApp?.I18n;
        const legendHidden = localStorage.getItem('gantt-legend-hidden') === '1';
        const legendContentHTML = `<span class="gantt-legend-title">${_L('层级', 'Level')}</span><span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#2563eb"></span>${_L('主任务', 'Main')}</span><span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#7c3aed"></span>${_L('一级子任务', 'L1')}</span><span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#0ea5e9"></span>${_L('二级子任务', 'L2')}</span><span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#10b981"></span>${_L('三级子任务', 'L3')}</span><span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#f97316"></span>${_L('四级子任务', 'L4')}</span><span class="gantt-legend-sep"></span><span class="gantt-legend-title">${I18n?.t('status.label') || '状态'}</span><span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#6366f1"></span>${_L('正常', 'On Track')}</span><span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#f59e0b"></span>${_L('即将到期', 'Due Soon')}</span><span class="gantt-legend-item"><span class="gantt-legend-dot" style="background:#ef4444"></span>${_L('已延期', 'Overdue')}</span><span class="gantt-legend-sep"></span><span class="gantt-legend-item"><span class="gantt-legend-dot gantt-legend-today"></span>${I18n?.t('gantt.today') || '今天'}</span>`;

        const toolbarHTML = `<button class="gantt-zoom-btn" data-gantt-action="export-svg" title="${_L('导出SVG', 'Export SVG')}" style="font-size:11px;font-weight:700;padding:0 10px;width:auto;">📐 SVG</button><button class="gantt-nav-btn" id="ganttPrevWeek" data-gantt-action="prevWeek" title="${_L('上一周 (←)', 'Previous Week (←)')}">${_L('← 一周', '← Week')}</button><button class="gantt-nav-btn today" id="ganttTodayBtn" data-gantt-action="today" title="${_L('回到今天 (T)', 'Today (T)')}">${I18n?.t('gantt.today') || '今天'}</button><button class="gantt-nav-btn" id="ganttNextWeek" data-gantt-action="nextWeek" title="${_L('下一周 (→)', 'Next Week (→)')}">${_L('一周 →', 'Week →')}</button><span class="gantt-toolbar-divider"></span><button class="gantt-date-preset-btn" id="ganttWeek" data-gantt-action="preset-week">${I18n?.t('reports.currentWeek') || '本周'}</button><button class="gantt-date-preset-btn" id="ganttMonth" data-gantt-action="preset-month">${_L('本月', 'Month')}</button><button class="gantt-date-preset-btn" id="ganttQuarter" data-gantt-action="preset-quarter">${I18n?.t('gantt.zoomQuarter') || '季度'}</button><span class="gantt-toolbar-divider"></span><button class="gantt-zoom-btn" id="ganttZoomOut" data-gantt-action="zoom-out" title="${_L('缩小 (-)', 'Zoom Out (-)')}">−</button><span class="gantt-zoom-level" id="ganttZoomLevel">${Math.round(gvs.zoomLevel * 100)}%</span><button class="gantt-zoom-btn" id="ganttZoomIn" data-gantt-action="zoom-in" title="${_L('放大 (+)', 'Zoom In (+)')}">+</button><span class="gantt-toolbar-divider"></span><button class="gantt-zoom-btn" data-gantt-action="export-img" title="${I18n?.t('gantt.exportImage') || '导出PNG'}" style="font-size:11px;font-weight:700;padding:0 10px;width:auto;">📷 PNG</button><button class="gantt-zoom-btn" data-gantt-action="export-excel" title="${I18n?.t('gantt.exportExcel') || '导出带时间轴与层级配色的 Excel 工作簿 (.xlsx)'}" style="font-size:11px;font-weight:700;padding:0 10px;width:auto;">📊 Excel</button><button class="gantt-zoom-btn" data-gantt-action="export-csv" title="${I18n?.t('gantt.exportCsv') || '导出纯文本 CSV 任务表 (.csv)'}" style="font-size:11px;font-weight:700;padding:0 10px;width:auto;">📄 CSV</button><div style="margin-left:auto;font-size:10px;color:var(--fg-soft);">${_L('← → 导航周 · T 今天 · +/- 缩放', '← → Week · T Today · +/- Zoom')}</div>`;

        const html = `<div class="gantt-toolbar gantt-toolbar-enhanced" style="border-radius:12px 12px 0 0;">${toolbarHTML}</div><div class="gantt-wrap"><div class="gantt-container" id="ganttContainer" style="position:relative;min-width:${260 + totalDays * dayWidth}px;border-radius:0;"><div class="gantt-scroll-hint" id="ganttScrollHint"></div>${headerHTML}<div class="gantt-body" id="ganttBody">${rows}</div></div></div><div class="gantt-legend-wrap" style="border-radius:0 0 12px 12px;"><div class="gantt-legend ${legendHidden ? 'hidden' : ''}" id="ganttLegend">${legendContentHTML}</div><button class="gantt-legend-toggle" id="ganttLegendToggle">${legendHidden ? _L('显示图例', 'Show Legend') : _L('隐藏图例', 'Hide Legend')}</button></div>`;

        // morphdom 增量更新：只有当缩放、折叠、导航（centerDate/presetMode）都没变时才走增量分支。
        // 折叠状态变化会导致 visibleTasks 数量变化，rows 长度变化，morphdom 能
        // 正确处理子节点增删，所以也走增量即可。
        const existingBody = document.getElementById('ganttBody');
        const existingHeader = document.getElementById('ganttContainer');
        const expectedMinWidth = 260 + totalDays * dayWidth;
        const zoomChanged = existingHeader && parseFloat(existingHeader.style.minWidth || '0') !== expectedMinWidth;
        const collapsedSig = Array.from(state.collapsed).sort().join('|');
        const collapsedChanged = gvs._lastCollapsedSig !== undefined && gvs._lastCollapsedSig !== collapsedSig;
        const prevCenterDate = gvs._lastCenterDate;
        const prevPresetMode = gvs._lastPresetMode;
        const navChanged = !prevCenterDate ? (gvs.centerDate !== null) : (gvs.centerDate && gvs.centerDate.getTime() !== prevCenterDate.getTime());
        const presetChanged = prevPresetMode !== gvs.presetMode;
        const curLocale = I18n?.getLocale?.() || null;
        const localeChanged = gvs._lastLocale !== undefined && gvs._lastLocale !== curLocale;
        const fullRebuild = !existingBody || zoomChanged || collapsedChanged || navChanged || presetChanged || localeChanged;
        gvs._lastCollapsedSig = collapsedSig;
        gvs._lastCenterDate = gvs.centerDate ? new Date(gvs.centerDate) : null;
        gvs._lastPresetMode = gvs.presetMode;
        gvs._lastLocale = curLocale;

        if (!fullRebuild) {
          _patchGanttBody(existingBody, rows);
          if (existingHeader) existingHeader.style.minWidth = expectedMinWidth + 'px';
        } else {
          container.innerHTML = html;
          // 完整替换 DOM 时，重新挂一次顶级代理事件
          this._bindEvents();
        }

        // tooltip + 滚动提示：每次 render 重新挂
        this._bindVolatileEvents();

        // 滚轮横向滚动（Ctrl+滚轮）已迁移到 _bindEvents 容器级委托（避免重复绑定）

      } catch (err) {
        if (isStale()) return;
        console.error('[GanttView.render] 错误:', err);
        container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">${_L('甘特图渲染失败', 'Failed to render Gantt chart')}</div><div class="empty-state-hint" style="color:#ef4444;font-family:monospace;font-size:11px;">${_escapeHtml(String(err))}</div></div>`;
      }
    },

    _bindEvents() {
      // 顶级事件委托：所有点击统一在容器根节点上处理。
      // mount 时绑一次；后续 render() 若 innerHTML 整体替换，会重新调用本方法
      // 先 remove 旧 listener 再 add 新 listener，幂等且无僵尸监听器。
      // morphdom 增量更新分支不调用本方法，原 listener 继续生效。
      // 防御 unmount() 把 _container 置 null 后切回甘特图：自动从 DOM 找回容器并恢复引用。
      let container = this._container;
      if (!container) {
        container = document.getElementById('viewContainer');
        if (container) this._container = container;
      }
      if (!container) return;

      // 1) 解绑旧的（防止重复绑定）
      if (this._clickHandler) {
        container.removeEventListener('click', this._clickHandler);
      }

      const state = window.ModuleApp.State.state;

      // 2) 定义统一的顶级代理 handler（保存到 this._clickHandler 以便下次 remove）
      this._clickHandler = (e) => {
        const target = e.target;

        // A. 工具栏按钮
        const btn = target.closest('[data-gantt-action]');
        if (btn) {
          const action = btn.dataset.ganttAction;
          const gvs = _gvs();
          if (action === 'prevWeek') { _shiftDays(-7); return; }
          if (action === 'nextWeek') { _shiftDays(7); return; }
          if (action === 'today') { const today = new Date(); today.setHours(0,0,0,0); gvs.centerDate = today; gvs.presetMode = null; this.render(); return; }
          if (action === 'zoom-in') { this.changeZoom(1); return; }
          if (action === 'zoom-out') { this.changeZoom(-1); return; }
          if (action.startsWith('preset-')) {
            const type = action.replace('preset-', '');
            document.querySelectorAll('.gantt-date-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _goToPreset(type);
            return;
          }
          if (action === 'export-svg') { _exportGanttSVG(); return; }
          if (action === 'export-img') { _exportGanttImage(); return; }
          if (action === 'export-excel') { _exportGanttExcel(); return; }
          if (action === 'export-csv') { _exportGanttCsv(); return; }
        }

        // B. 折叠/展开（▶/▼）
        const toggle = target.closest('.gantt-collapse-toggle');
        if (toggle) {
          const taskId = toggle.dataset.collapse;
          if (!taskId) return;
          const newCol = new Set(state.collapsed);
          if (newCol.has(taskId)) newCol.delete(taskId);
          else newCol.add(taskId);
          window.ModuleApp.State.patch({ collapsed: newCol });
          this.render();
          return;
        }

        // C. 任务名/无日期行：跳转到任务开始日期（核心功能！）
        const jumpEl = target.closest('[data-gantt-jump]');
        if (jumpEl) {
          const t = state.tasks.find(x => x.id === jumpEl.dataset.ganttJump);
          if (!t) return;
          const startStr = t.startDate || t.start;
          if (!startStr) { window.ModuleApp.Toast.show(window.ModuleApp?.I18n?.t('gantt.noDates') || '该任务没有日期，无法对齐', 'warning'); return; }
          const [yy, mm2, dd2] = startStr.split('-').map(Number);
          const targetDate = new Date(yy, mm2 - 1, dd2);
          targetDate.setHours(0, 0, 0, 0);
          const minDate = _getMinDate(state.tasks);
          const targetDay = Math.round((targetDate - minDate) / 86400000);
          const ganttWrap = document.querySelector('.gantt-wrap');
          if (ganttWrap) ganttWrap.scrollLeft = Math.max(0, targetDay * (28 * _gvs().zoomLevel) - 8);
          _gvs().centerDate = targetDate;
          _gvs().presetMode = null;
          return;
        }

        // D. 甘特图条 → 编辑任务
        const bar = target.closest('.gantt-bar');
        if (bar) {
          const taskId = bar.dataset.taskId;
          if (taskId && window.ModuleApp.TaskController) {
            window.ModuleApp.TaskController.openEditModal(taskId);
          }
          return;
        }

        // E. 行空白处 → 选中行
        const row = target.closest('.gantt-row[data-task-id]');
        if (row) {
          const wasSelected = row.classList.contains('selected');
          document.querySelectorAll('.gantt-row').forEach(r => r.classList.remove('selected'));
          if (!wasSelected) { row.classList.add('selected'); _gvs().selectedTaskId = row.dataset.taskId; }
          else { _gvs().selectedTaskId = null; }
        }

        // ========== 🚀 修复：绑定图例切换事件 ==========
        if (target.id === 'ganttLegendToggle') {
          const legend = document.getElementById('ganttLegend');
          if (!legend) return;
          const isHidden = legend.classList.contains('hidden');
          if (isHidden) {
            legend.classList.remove('hidden');
            target.textContent = _L('隐藏图例', 'Hide Legend');
            localStorage.setItem('gantt-legend-hidden', '0');
          } else {
            legend.classList.add('hidden');
            target.textContent = _L('显示图例', 'Show Legend');
            localStorage.setItem('gantt-legend-hidden', '1');
          }
          return;
        }
        // ===============================================
      };

      // 3) 绑定到容器根
      container.addEventListener('click', this._clickHandler);

      // 4) 滚轮横向滚动（Ctrl/Cmd+滚轮）— 容器级委托，避免 morphdom 增量更新后重复绑定
      //    只在 mount 时绑一次；container 是固定的，即使内部 DOM 被替换也能拦截
      this._wheelHandler = (e) => {
        if (e.shiftKey) return;
        if (!(e.ctrlKey || e.metaKey)) return;
        const wrap = e.target.closest && e.target.closest('.gantt-wrap');
        if (!wrap) return;
        e.preventDefault();
        wrap.scrollLeft += e.deltaY;
      };
      container.addEventListener('wheel', this._wheelHandler, { passive: false });

      // 5) 键盘导航（document 级，unmount 时统一解绑）
      document.removeEventListener('keydown', _handleGanttKeys);
      document.addEventListener('keydown', _handleGanttKeys);
    },

    // 每次 render 后调用：挂 tooltip（按需重新创建）+ 初始化滚动提示
    _bindVolatileEvents() {
      // 滚动提示（每次 render 都重新挂，因为 ganttWrap 可能是新 DOM）
      const scrollHint = document.getElementById('ganttScrollHint');
      const ganttWrap = document.querySelector('.gantt-wrap');
      if (scrollHint && ganttWrap) {
        const checkHint = () => {
          const maxScroll = ganttWrap.scrollWidth - ganttWrap.clientWidth;
          scrollHint.classList.toggle('visible', ganttWrap.scrollLeft < maxScroll - 20);
        };
        ganttWrap.addEventListener('scroll', checkHint);
        setTimeout(checkHint, 100);
      }
      // tooltip
      _initGanttTooltip();
    }
  };

  // ==================== 私有工具函数 ====================

  // 当前渲染上下文缓存：每次 render() 把 minDate/totalDays/dayWidth 写进来，
  // 解决 P1-5：_getMinDate 之前无视 centerDate/presetMode，永远返回"今天-7天"，
  // 导致点击任务名跳转时 scrollLeft 算错。
  let _renderCtx = { minDate: null, totalDays: 0, dayWidth: 28 };

  function _getMinDate(tasks) {
    // 优先用当前 render() 的 minDate（已经考虑 centerDate/presetMode/minSpan）
    if (_renderCtx.minDate) return _renderCtx.minDate;
    // 兜底：render() 还没跑过
    const now = new Date(); now.setHours(0, 0, 0, 0);
    return new Date(now.getTime() - 7 * 86400000);
  }

  function _parseLocalDate(iso) {
    if (!iso) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    return new Date(iso);
  }

  function _shiftDays(delta) {
    const gvs = _gvs();
    const now = new Date(); now.setHours(0, 0, 0, 0);
    if (!gvs.centerDate) gvs.centerDate = new Date(now);
    gvs.centerDate.setDate(gvs.centerDate.getDate() + delta);
    gvs.presetMode = null;
    GanttView.render();
  }

  function _getPresetStart(type) {
    const startOfDay = (d) => { const dt = new Date(d); dt.setHours(0,0,0,0); return dt; };
    const now = startOfDay(new Date());
    if (type === 'week') {
      // 返回本周一（周一开始）
      const d = new Date(now);
      const day = d.getDay(); // 0=周日, 1=周一 ... 6=周六
      const diff = day === 0 ? -6 : 1 - day; // 周日(-6), 周一(0), 周二(-1)...周六(-5)
      d.setDate(d.getDate() + diff);
      return startOfDay(d);
    }
    const d = new Date(now);
    if (type === 'month') d.setDate(1);
    else if (type === 'quarter') { d.setMonth(Math.floor(d.getMonth() / 3) * 3); d.setDate(1); }
    return startOfDay(d);
  }

  function _goToPreset(type) {
    const gvs = _gvs();
    gvs.centerDate = _getPresetStart(type);
    gvs.presetMode = type;
    GanttView.render();
  }

  function _makeGanttRow(t, minDate, totalDays, dayWidth, today, todayDay, todayColLeft, showTodayLine, ganttOffsetPx, ganttWeekPx, hasGanttChildren) {
    const state = window.ModuleApp.State.state;
    const VIEW_WIDTH = totalDays * dayWidth;
    const displayLevel = Math.min(t.level || 0, 4);
    const indent = displayLevel * 18;
    const barTop = displayLevel === 0 ? 8 : 12;
    const barH = displayLevel === 0 ? 28 : 20;

    let badge = '';
    const I18n = window.ModuleApp?.I18n;
    if (t.end) {
      const [ey, em, ed] = t.end.split('-').map(Number);
      const ed2 = new Date(ey, em - 1, ed);
      const diff = Math.round((ed2 - today) / 86400000);
      if (diff < 0) badge = `<span class="gantt-task-deadline-badge danger">${I18n?.t('deadline.daysOverdue', { days: Math.abs(diff) }) || `逾期${Math.abs(diff)}天`}</span>`;
      else if (diff === 0) badge = `<span class="gantt-task-deadline-badge warning">${I18n?.t('deadline.today') || '今天'}</span>`;
      else if (diff === 1) badge = `<span class="gantt-task-deadline-badge warning">${I18n?.t('deadline.tomorrow') || '明天'}</span>`;
      else if (diff <= 7) badge = `<span class="gantt-task-deadline-badge warning">${I18n?.t('deadline.daysLeft', { days: diff }) || `${diff}天后`}</span>`;
    }

    const isCollapsed = state.collapsed.has(t.id);
    const hasKids = !!(hasGanttChildren && hasGanttChildren[t.id]);
    const collapseIcon = hasKids ? `<span class="gantt-collapse-toggle" data-collapse="${t.id}">${isCollapsed ? '▶' : '▼'}</span>` : '';

    if (!t.start || !t.end) {
      return `<div class="gantt-row gantt-row-no-date" data-task-id="${t.id}"><div class="gantt-task-name" data-gantt-jump="${t.id}" style="padding-left:${indent + 12}px;cursor:pointer;">${collapseIcon}<span class="gantt-level-dot level-${displayLevel}"></span><span class="gantt-task-name-text">${_escapeHtml(t.content)}</span><span class="gantt-task-no-date-hint">${I18n?.t('gantt.noDates') || '无日期'}</span></div><div class="gantt-track" style="width:${VIEW_WIDTH}px;"></div></div>`;
    }

    const [sy, sm, sd] = t.start.split('-').map(Number);
    const [ey2, em2, ed2] = t.end.split('-').map(Number);
    const startD = new Date(sy, sm - 1, sd);
    const endD = new Date(ey2, em2 - 1, ed2);
    const startOffset = Math.round((startD - minDate) / 86400000);
    const endOffset = Math.round((endD - minDate) / 86400000);
    const left = startOffset * dayWidth;
    const width = Math.max(dayWidth, (endOffset - startOffset) * dayWidth);

    let statusCls = '';
    if (endD < today) {
      statusCls = 'overdue';
    } else {
      const diffToNow = Math.round((endD - today) / 86400000);
      if (diffToNow <= 7) statusCls = 'due-soon';
    }
    const barBg = statusCls === 'overdue' ? '#ef4444' : statusCls === 'due-soon' ? '#f59e0b' : '#6366f1';

    let bgLayers = [];
    if (showTodayLine) bgLayers.push(`linear-gradient(to right, transparent ${todayColLeft}px, rgba(239,68,68,0.06) ${todayColLeft}px, rgba(239,68,68,0.06) ${todayColLeft + dayWidth}px, transparent ${todayColLeft + dayWidth}px)`);
    bgLayers.push(`repeating-linear-gradient(to right, transparent 0, transparent ${5*dayWidth}px, rgba(0,0,0,0.03) ${5*dayWidth}px, rgba(0,0,0,0.03) ${7*dayWidth}px)`);
    const trackStyle = `width:${VIEW_WIDTH}px;background-image:${bgLayers.join(',')};background-position:0 0, ${ganttOffsetPx}px 0;background-size:100% 100%, ${ganttWeekPx}px 100%;`;

    return `<div class="gantt-row" data-task-id="${t.id}"><div class="gantt-task-name" data-gantt-jump="${t.id}" style="padding-left:${indent + 12}px;cursor:pointer;">${collapseIcon}<span class="gantt-level-dot level-${displayLevel}"></span><span class="gantt-task-name-text">${_escapeHtml(t.content)}</span>${badge}</div><div class="gantt-track" style="${trackStyle}"><div class="gantt-bar ${statusCls}" data-task-id="${t.id}" style="left:${left}px;top:${barTop}px;width:${width}px;height:${barH}px;background:${barBg};"></div></div></div>`;
  }

  function _generateGanttHeader(minDate, totalDays, dayWidth, todayDay, showTodayLine, todayColLeft, ganttOffsetPx, ganttWeekPx) {
    const isWeekendDay = window.ModuleApp.Utils ? window.ModuleApp.Utils.isWeekendDay : (d => d.getDay() === 0 || d.getDay() === 6);
    const I18n = window.ModuleApp?.I18n;
    const weekdays = (I18n && Array.isArray(I18n.t('datePicker.weekdaysShort'))) ? I18n.t('datePicker.weekdaysShort') : ['一', '二', '三', '四', '五', '六', '日'];

    let html = `<div class="gantt-header" style="height:70px;">`;
    html += `<div class="gantt-header-name-cell" style="display:flex;align-items:flex-end;padding:0 16px 8px;font-size:10px;color:var(--fg-soft);letter-spacing:0.5px;font-weight:700;">${I18n?.t('gantt.taskName') || '任务名称'}</div>`;
    const trackHeaderStyle = `width:${totalDays * dayWidth}px;overflow:visible;position:relative;background-position:${ganttOffsetPx}px 26px, ${ganttOffsetPx - dayWidth}px 26px;background-size:${ganttWeekPx}px 100%, ${ganttWeekPx}px 100%;background-image:repeating-linear-gradient(to right, transparent 0, transparent ${5*dayWidth}px, var(--gantt-weekend-bg, #fef2f2) ${5*dayWidth}px, var(--gantt-weekend-bg, #fef2f2) ${7*dayWidth}px),repeating-linear-gradient(to right, transparent 0, transparent ${6*dayWidth}px, var(--line) ${6*dayWidth}px, var(--line) ${6*dayWidth + 1}px, transparent ${6*dayWidth + 1}px, transparent ${7*dayWidth}px);background-repeat:repeat, repeat;`;
    html += `<div class="gantt-track-header" style="${trackHeaderStyle}">`;

    // P2-10 修复：用 Set 替代 Array.includes（O(1) vs O(n)）+ 缓存 new Date()（避免循环内重复调用）
    const addedMonths = new Set();
    const nowYear  = new Date().getFullYear();
    const nowMonth = new Date().getMonth();
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(minDate); d.setDate(d.getDate() + i);
      // key 包含年份，同年同月才合并；跨年同月会被识别为不同月份
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (addedMonths.has(key)) continue;
      let lastSame = i;
      for (let j = i + 1; j < totalDays; j++) {
        const dj = new Date(minDate); dj.setDate(dj.getDate() + j);
        if (dj.getFullYear() === d.getFullYear() && dj.getMonth() === d.getMonth()) lastSame = j;
        else break;
      }
      const left = i * dayWidth;
      const width = (lastSame - i + 1) * dayWidth;
      const isEn = I18n?.getLocale?.() === 'en-US';
      const enMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const label = isEn
        ? (d.getMonth() === 0 ? `${d.getFullYear()} Jan` : enMonths[d.getMonth()])
        : (d.getMonth() === 0 ? `${d.getFullYear()}年1月` : `${d.getMonth() + 1}月`);
      const isCurrentMonth = d.getMonth() === nowMonth && d.getFullYear() === nowYear;
      html += `<span class="gantt-month-label" style="left:${left}px;width:${width}px;text-align:${i === 0 ? 'left' : 'center'};padding-left:${i === 0 ? '4px' : '0'};color:${isCurrentMonth ? 'var(--primary)' : 'inherit'}">${label}</span>`;
      if (lastSame < totalDays - 1) html += `<span class="gantt-month-sep" style="left:${(lastSame + 1) * dayWidth}px"></span>`;
      addedMonths.add(key);
    }

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(minDate); d.setDate(d.getDate() + i);
      const dow = d.getDay();
      const isWeekend = isWeekendDay(d, 1);
      const isToday = i === todayDay;
      const weekColor = isWeekend ? 'var(--danger)' : isToday ? '#ef4444' : 'var(--fg-muted)';
      html += `<span class="gantt-weekday-label" style="left:${i * dayWidth + dayWidth / 2}px;color:${weekColor};font-weight:${isToday ? '800' : '600'}">${weekdays[dow === 0 ? 6 : dow - 1]}</span>`;
      const dayColor = isWeekend ? 'var(--danger);opacity:0.6' : isToday ? '#ef4444;font-weight:800' : 'var(--fg-muted)';
      html += `<span class="gantt-day-label" style="left:${i * dayWidth + dayWidth / 2}px;color:${dayColor}">${d.getDate()}</span>`;
    }

    html += `<div style="position:absolute;bottom:0;left:0;right:0;height:1px;background:var(--line)"></div></div></div>`;
    return html;
  }

  // Tooltip 状态：当前展示的 tip DOM 节点
  let _activeTip = null;
  let _tooltipInitialized = false;

  // 一次性绑定容器级 mouseover/mouseout/mousemove 委托，处理 .gantt-bar 悬停
  // 解决 P0-2：原本每次 render() 都给每个 .gantt-bar 重复 addEventListener，导致
  // tooltip 多次触发 + 内存泄漏
  function _initGanttTooltip() {
    if (_tooltipInitialized) return;
    const container = GanttView._container;
    if (!container) return;
    _tooltipInitialized = true;

    const state = window.ModuleApp.State.state;

    container.addEventListener('mouseover', e => {
      const bar = e.target.closest && e.target.closest('.gantt-bar');
      if (!bar) return;
      const taskId = bar.dataset.taskId;
      if (!taskId) return;
      if (_activeTip && _activeTip.dataset.taskId === taskId) return;  // 已经在显示
      _hideTooltip();
      const t = state.tasks.find(x => x.id === taskId);
      if (!t) return;
      const rawEnd = t.end || t.deadline;
      const today = new Date(); today.setHours(0,0,0,0);
      const I18n = window.ModuleApp?.I18n;
      let diffText = '';
      let statusClass = '';
      if (rawEnd) {
        const [yy, mm2, dd2] = rawEnd.split('-').map(Number);
        const ed2 = new Date(yy, mm2 - 1, dd2);
        const diff = Math.round((ed2 - today) / 86400000);
        if (diff < 0) {
          statusClass = 'overdue';
          diffText = '⚠ ' + (I18n?.t('deadline.daysOverdue', { days: Math.abs(diff) }) || `已逾期 ${Math.abs(diff)} 天`);
        } else if (diff === 0) {
          statusClass = 'due-soon';
          diffText = '⏰ ' + (I18n?.t('deadline.dueToday') || '今天截止');
        } else {
          diffText = I18n?.t('deadline.daysLeft', { days: diff }) || `剩余 ${diff} 天`;
        }
      }
      const notesHtml = t.notes ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.15);font-size:11px;opacity:0.8;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${_escapeHtml(t.notes)}</div>` : '';
      const tip = document.createElement('div');
      tip.className = 'gantt-tooltip';
      tip.dataset.taskId = taskId;
      tip.innerHTML = `<div class="gantt-tooltip-title">${_escapeHtml(t.content)}</div>${t.startDate ? `<div class="gantt-tooltip-row"><span class="gantt-tooltip-label">${I18n?.t('gantt.startDate') || '开始'}</span><span>${t.startDate}</span></div>` : ''}${t.deadline ? `<div class="gantt-tooltip-row"><span class="gantt-tooltip-label">${I18n?.t('gantt.endDate') || '截止'}</span><span>${t.deadline}</span></div>` : ''}${diffText ? `<div class="gantt-tooltip-row"><span class="gantt-tooltip-label">${I18n?.t('status.label') || '状态'}</span><span class="gantt-tooltip-status ${statusClass}">${diffText}</span></div>` : ''}${notesHtml}`;
      document.body.appendChild(tip);
      _activeTip = tip;
      _positionTip(e, tip);
    });

    container.addEventListener('mousemove', e => {
      if (_activeTip) _positionTip(e, _activeTip);
    });

    container.addEventListener('mouseout', e => {
      const bar = e.target.closest && e.target.closest('.gantt-bar');
      if (!bar) return;
      // 鼠标离开时检查是否进入子元素（事件冒泡时不重复显示）
      if (e.relatedTarget && bar.contains(e.relatedTarget)) return;
      _hideTooltip();
    });
  }

  function _hideTooltip() {
    if (_activeTip) {
      _activeTip.remove();
      _activeTip = null;
    }
  }

  function _positionTip(e, t) {
    const x = e.clientX + 14, y = e.clientY - 10;
    const r = t.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    t.style.left = (x + r.width > vw ? e.clientX - r.width - 14 : x) + 'px';
    t.style.top = (y + r.height > vh ? e.clientY - r.height + 10 : y) + 'px';
  }

  // 模块级活跃标记：mount() 时设为 true，unmount() 时设为 false
  // 解决 P0-3：原本依赖 viewTitle 文字判断视图，耦合 DOM 文案
  let _isActive = false;

  function _handleGanttKeys(e) {
    if (!_isActive) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); _shiftDays(e.shiftKey ? -30 : -7); }
    if (e.key === 'ArrowRight') { e.preventDefault(); _shiftDays(e.shiftKey ? 30 : 7); }
    if (e.key === 't' || e.key === 'T') { e.preventDefault(); _gvs().centerDate = null; GanttView.render(); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); GanttView.changeZoom(1); }
    if (e.key === '-') { e.preventDefault(); GanttView.changeZoom(-1); }
    if (e.key === 'Escape') {
      document.querySelectorAll('.gantt-row').forEach(r => r.classList.remove('selected'));
      _gvs().selectedTaskId = null;
    }
  }

  function _patchGanttBody(container, newRowsHtml) {
    if (typeof morphdom === 'undefined') {
      container.innerHTML = newRowsHtml;
      return;
    }
    // 关键修复：morphdom 第二参数必须是 DOM 节点，不能是字符串。
    // morphdom 内部做"从字符串无法推断出节点类型"的判断时会静默失败，
    // 退化成 innerHTML 替换，破坏了我们对增量更新的依赖。
    // 解决方案：先把 HTML 字符串解析到临时 div，再把临时 div 的子节点 patch 进 container。
    const temp = document.createElement('div');
    temp.innerHTML = newRowsHtml;
    morphdom(container, temp, {
      childrenOnly: true,
      // 显式指定节点匹配键，让 DOM 节点能按 task-id 复用/搬移，减少无谓重绘
      getNodeKey: function(node) {
        if (node && node.getAttribute) {
          return node.getAttribute('data-task-id') || node.id || null;
        }
        return null;
      },
      onBeforeElUpdated(fromEl) {
        if (document.activeElement && (fromEl.contains(document.activeElement) || fromEl === document.activeElement)) return false;
        return true;
      }
    });
  }

  // ==================== 导出函数 ====================

  // P1: SVG 导出 — 纯前端自闭环，零 IPC 传输，零 OOM 风险
  // 使用 foreignObject + 内联样式将甘特图 DOM 序列化为 .svg 文件，
  // 可在浏览器/Illustrator/Figma 中打开编辑。
  async function _exportGanttSVG() {
    try {
      const ganttContainer = document.querySelector('.gantt-container');
      if (!ganttContainer) throw new Error(_L('找不到甘特图容器', 'Gantt container not found'));

      const rect = ganttContainer.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) throw new Error(_L('甘特图尺寸为零', 'Gantt chart has zero size'));
      // Chrome SVG canvas 硬限：宽/高 ≤ 32,767px
      if (rect.width > 32000 || rect.height > 32000) {
        window.ModuleApp.Toast.show(_L('⚠️ 甘特图跨度过大，请使用 Excel 导出', '⚠️ Gantt span too large, please export to Excel'), 'error');
        return;
      }

      window.ModuleApp.Toast.show(_L('正在生成 SVG，请稍候...', 'Generating SVG, please wait...'), 'info');

      // 克隆甘特图容器（含 header + body）
      const clone = ganttContainer.cloneNode(true);
      // 移除 tooltip
      clone.querySelectorAll('.gantt-tooltip').forEach(el => el.remove());

      const w = Math.ceil(rect.width);
      const h = Math.ceil(rect.height);

      // 收集 gantt 相关 CSS 规则
      const styleText = _collectGanttStyles();

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('xmlns', svgNS);
      svg.setAttribute('width', String(w));
      svg.setAttribute('height', String(h));
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

      const fo = document.createElementNS(svgNS, 'foreignObject');
      fo.setAttribute('width', '100%');
      fo.setAttribute('height', '100%');
      fo.setAttribute('requiredExtensions', 'http://www.w3.org/1999/xhtml');

      const wrapper = document.createElement('div');
      wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      wrapper.innerHTML = `<style>${styleText}</style>`;
      wrapper.appendChild(clone);
      fo.appendChild(wrapper);
      svg.appendChild(fo);

      const svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        new XMLSerializer().serializeToString(svg);

      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      a.download = _L(`Module_甘特图_${stamp}.svg`, `Module_Gantt_${stamp}.svg`);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      window.ModuleApp.Toast.show(_L('✅ SVG 已下载', '✅ SVG downloaded'), 'success');
    } catch (err) {
      console.error('[exportGanttSVG] 失败:', err);
      window.ModuleApp.Toast.show(_L('SVG 导出失败，尝试 PNG 导出...', 'SVG export failed, trying PNG...'), 'warning');
      _exportGanttImage();
    }
  }

  // 收集所有 .gantt-* 相关的 CSS 规则，使 SVG 脱离宿主 CSS 后仍能正确渲染
  function _collectGanttStyles() {
    let css = '';
    const bodyStyle = getComputedStyle(document.body);
    const vars = [
      '--bg', '--bg-card', '--bg-hover', '--fg', '--fg-muted', '--fg-soft',
      '--line', '--line-strong', '--primary', '--primary-hover', '--primary-soft',
      '--success', '--warning', '--warning-bg', '--danger', '--danger-bg',
      '--info', '--info-bg', '--shadow', '--shadow-md', '--radius', '--radius-sm',
      '--gantt-weekend-bg'
    ];
    const resolvedVars = vars
      .map(v => {
        const val = bodyStyle.getPropertyValue(v).trim();
        return val ? `${v}:${val};` : '';
      })
      .filter(Boolean)
      .join('');
    if (resolvedVars) css += `:root{${resolvedVars}}\n`;

    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            const sel = rule.cssText || '';
            if (/gantt/i.test(sel)) css += sel + '\n';
          }
        } catch (_) { /* 跨域样式表跳过 */ }
      }
    } catch (_) {}
    // 兜底背景色
    const bg = bodyStyle.getPropertyValue('--bg-card').trim() || '#ffffff';
    css += `.gantt-container{background:${bg};font-family:system-ui,-apple-system,sans-serif;}\n`;
    return css;
  }

  async function _exportGanttImage() {
    try {
      const auth = await _api.gantt.requestSavePath();
      if (!auth) return;
      const { filePath: savePath, token } = auth;
      const ganttWrap = document.querySelector('.gantt-wrap');
      const scrollW = ganttWrap ? ganttWrap.scrollWidth : 0;
      // Bug-A 修复：动态调整 scale 防止 Chrome canvas 尺寸溢出崩溃
      // Chrome/Edge 硬性限制：canvas 宽/高 ≤ 32,767px，面积 ≤ 268,435,456 px
      let renderScale = 2;
      if (scrollW > 15000) renderScale = 1;
      if (scrollW > 30000) {
        window.ModuleApp.Toast.show(_L('⚠️ 甘特图跨度过大，已超出浏览器绘图极限，请使用 Excel 导出', '⚠️ Gantt span exceeds browser canvas limit, please use Excel export'), 'error');
        return;
      }
      if (scrollW > 8000) window.ModuleApp.Toast.show(_L('⚠️ 甘特图跨度过大，建议缩小缩放或使用 Excel 导出！', '⚠️ Gantt span is large, consider zooming out or using Excel export!'), 'warning', 5000);
      window.ModuleApp.Toast.show(_L('正在生成高分辨率图片，请稍候...', 'Generating high-res image, please wait...'), 'info');

      const toolbar = document.querySelector('.gantt-toolbar');
      const legend = document.querySelector('.gantt-legend');
      const origToolbar = toolbar ? toolbar.style.display : '';
      const origLegend = legend ? legend.style.display : '';
      const stickyEls = document.querySelectorAll('.gantt-header-name-cell, .gantt-task-name, .gantt-header, .gantt-track-header');
      const origPos = [];
      stickyEls.forEach((el, i) => { origPos[i] = el.style.position; el.style.position = 'static'; });
      const origWrapOverflow = ganttWrap ? ganttWrap.style.overflow : '';
      const origWrapMaxHeight = ganttWrap ? ganttWrap.style.maxHeight : '';
      const origScrollLeft = ganttWrap ? ganttWrap.scrollLeft : 0;
      const origScrollTop = ganttWrap ? ganttWrap.scrollTop : 0;
      if (ganttWrap) {
        ganttWrap.style.overflow = 'visible';
        ganttWrap.style.maxHeight = 'none';
        ganttWrap.scrollLeft = 0;
        ganttWrap.scrollTop = 0;
      }
      if (toolbar) toolbar.style.display = 'none';
      if (legend) legend.style.display = 'none';

      let arrayBuffer = null;
      try {
        if (typeof html2canvas === 'undefined') throw new Error(_L('html2canvas 未加载', 'html2canvas not loaded'));
        const ganttContainer = document.querySelector('.gantt-wrap');
        if (!ganttContainer) throw new Error(_L('找不到甘特图容器', 'Gantt container not found'));
        const bgColor = getComputedStyle(document.body).getPropertyValue('--bg-card').trim() || (document.body.classList.contains('theme-dark') ? '#1e293b' : '#ffffff');
        const canvas = await html2canvas(ganttContainer, {
          backgroundColor: bgColor,
          scale: renderScale, useCORS: true, logging: false,
        });
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        arrayBuffer = await blob.arrayBuffer();
      } finally {
        if (toolbar) toolbar.style.display = origToolbar;
        if (legend) legend.style.display = origLegend;
        stickyEls.forEach((el, i) => { el.style.position = origPos[i] || ''; });
        if (ganttWrap) {
          ganttWrap.style.overflow = origWrapOverflow;
          ganttWrap.style.maxHeight = origWrapMaxHeight;
          ganttWrap.scrollLeft = origScrollLeft;
          ganttWrap.scrollTop = origScrollTop;
        }
      }

      if (arrayBuffer) {
        const result = await _api.gantt.writeImageBuffer(savePath, arrayBuffer, token);
        const I18n = window.ModuleApp?.I18n;
        if (result.success) window.ModuleApp.Toast.show(_L('✅ 图片已保存', '✅ Image saved'), 'success');
        else window.ModuleApp.Toast.show('❌ ' + (result.error || _L('保存失败', 'Save failed')), 'error');
      }
    } catch (err) {
      const I18n = window.ModuleApp?.I18n;
      window.ModuleApp.Toast.show('❌ ' + (I18n?.t('gantt.exportFailed', { error: err.message }) || ('导出失败: ' + err.message)), 'error');
    }
  }

  async function _exportGanttExcel() {
    const I18n = window.ModuleApp?.I18n;
    try {
      const scopeIds = window.ModuleApp.State?.state?.projectScopeIds || [];
      const result = await _api.gantt.exportExcel(scopeIds);
      if (!result || result.canceled) return;
      if (result.success) window.ModuleApp.Toast.show(_L('✅ Excel 已导出到: ', '✅ Excel exported to: ') + result.path, 'success');
      else if (result.error) window.ModuleApp.Toast.show('❌ ' + result.error, 'error');
      else window.ModuleApp.Toast.show('❌ ' + _L('导出失败', 'Export failed'), 'error');
    } catch (err) {
      window.ModuleApp.Toast.show('❌ ' + (I18n?.t('gantt.exportFailed', { error: err.message }) || ('导出失败: ' + err.message)), 'error');
    }
  }

  async function _exportGanttCsv() {
    const I18n = window.ModuleApp?.I18n;
    try {
      const scopeIds = window.ModuleApp.State?.state?.projectScopeIds || [];
      if (typeof _api.gantt?.exportCsv === 'function') {
        const result = await _api.gantt.exportCsv(scopeIds);
        if (!result || result.canceled) return;
        if (result.success) window.ModuleApp.Toast.show(_L('✅ CSV 已导出到: ', '✅ CSV exported to: ') + result.path, 'success');
        else if (result.error) window.ModuleApp.Toast.show('❌ ' + result.error, 'error');
        else window.ModuleApp.Toast.show('❌ ' + _L('导出失败', 'Export failed'), 'error');
        return;
      }
      // Electron 兼容兜底：按当前 projectScopeIds 导出 UTF-8 BOM CSV
      const data = await _api.gantt.data();
      const state = window.ModuleApp.State?.state || {};
      const PS = window.ModuleApp.ProjectScope;
      const vis = PS ? PS.visibleIdSet(state.tasks, scopeIds) : null;
      const rows = (data || []).filter(t => !vis || vis.has(t.id));
      let csv = _L('\uFEFF任务ID,任务内容,层级,开始日期,截止日期\n', '\uFEFFTask ID,Task,Level,Start Date,End Date\n');
      for (const t of rows) {
        csv += `"${t.id || ''}","${String(t.content || '').replace(/"/g, '""')}",${t.level ?? 0},"${t.start || ''}","${t.end || ''}"\n`;
      }
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      a.href = url;
      a.download = _L(`甘特图-${stamp}.csv`, `Gantt-${stamp}.csv`);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      window.ModuleApp.Toast.show(_L('✅ CSV 已下载', '✅ CSV downloaded'), 'success');
    } catch (err) {
      window.ModuleApp.Toast.show('❌ ' + (I18n?.t('gantt.exportFailed', { error: err.message }) || ('CSV 导出失败: ' + err.message)), 'error');
    }
  }

  function _escapeHtml(s) {
    if (!s) return '';
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ==================== 注册 ====================
  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.GanttView = GanttView;
})();
