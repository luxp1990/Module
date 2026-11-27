// Module — 视图：周报视图 (时间足迹为主 + 统计图表 + 备注沉底)
// 基于 1.7.7 + 周报修复（终态收尾/上周按钮/时区/undo/删除墓碑）之上重构：
//   - 默认【时间足迹】视角，可按周一到周日查看完成流转
//   - 【每日完成趋势】柱状图 + 主/子任务分布统计
//   - 备注区沉底，精简为「📝 备注」
//   - 一键复制周报文本（走主进程 clipboard，Electron file:// 下可靠）
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

  function _escapeHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _renderSimpleMarkdown(md) {
    const escaped = _escapeHtml(String(md || ''));
    const formatInline = (text) => text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const lines = escaped.split(/\r?\n/);
    const out = [];
    let inList = false;

    const closeList = () => {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        closeList();
        continue;
      }
      if (/^---+$/.test(line)) {
        closeList();
        out.push('<hr>');
        continue;
      }
      const h3 = line.match(/^###\s+(.+)$/);
      if (h3) {
        closeList();
        out.push(`<h3>${formatInline(h3[1])}</h3>`);
        continue;
      }
      const h2 = line.match(/^##\s+(.+)$/);
      if (h2) {
        closeList();
        out.push(`<h2>${formatInline(h2[1])}</h2>`);
        continue;
      }
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1) {
        closeList();
        out.push(`<h1>${formatInline(h1[1])}</h1>`);
        continue;
      }
      const li = line.match(/^[-*]\s+(.+)$/);
      if (li) {
        if (!inList) {
          out.push('<ul>');
          inList = true;
        }
        out.push(`<li>${formatInline(li[1])}</li>`);
        continue;
      }
      closeList();
      out.push(`<p>${formatInline(line)}</p>`);
    }
    closeList();
    return out.join('\n');
  }

  // Calendar dates stay literal; legacy timestamp boundaries must be converted to local time.
  function _fmtDate(iso) {
    if (!iso) return '';
    const s = String(iso);
    const isEn = _locale() === 'en-US';
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      return isEn ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}年${m[2]}月${m[3]}日`;
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const mo = String(d.getMonth()+1).padStart(2,'0');
    const da = String(d.getDate()).padStart(2,'0');
    return isEn ? `${y}-${mo}-${da}` : `${y}年${mo}月${da}日`;
  }

  function _fmtDateShort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return (d.getMonth()+1) + '/' + d.getDate();
  }

  function _dayKey(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  function _dayLabel(key) {
    if (!key) return '';
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m-1, d);
    if (_locale() === 'en-US') {
      const wEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
      return `${m}/${d} (${wEn})`;
    }
    const w = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()];
    return m + '/' + d + ' 周' + w;
  }

  // 任务归属分组名（项目归类视角用）
  function _groupName(e) {
    if (e.parentContent) return e.parentContent;
    return e.level === 0
      ? _t('reports.independentTask', null, '独立主任务', 'Independent Tasks')
      : _t('reports.otherItems', null, '其他事项', 'Other');
  }

  // 格式化一键复制的周报文本（时间足迹排版，备注沉底）
  function _formatReportText(r) {
    const start = _fmtDate(r.startDate);
    const end = _fmtDate(r.endDate);
    const headerTitle = _t('reports.weekLabel', { weekId: r.weekId }, `${r.weekId} 周报`, `Week ${r.weekId} Report`);
    const lines = [
      `【${headerTitle}】（${start} ~ ${end}）`,
      _t('reports.completedCountLine', { count: r.count }, `本周完成：${r.count} 项工作`, `Completed: ${r.count} tasks`),
      ''
    ];

    lines.push(_t('reports.detailsHeader', null, '📋 工作完成明细：', '📋 Completed Details:'));
    if (!r.entries || r.entries.length === 0) {
      lines.push(_t('reports.noEntriesLine', null, '（本周暂无已完成任务）', '(No completed tasks this week)'));
    } else {
      const sortedEntries = r.entries.slice().sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
      let lastDay = '';
      for (const e of sortedEntries) {
        const cur = _dayKey(e.completedAt);
        if (cur !== lastDay) {
          lines.push('📅 ' + _dayLabel(cur) + '：');
          lastDay = cur;
        }
        const parent = e.parentContent ? '[' + e.parentContent + '] ' : '';
        lines.push('  ✓ ' + parent + e.content + ' (' + _fmtDateShort(e.completedAt) + ')');
      }
    }

    if (r.notes && r.notes.trim()) {
      lines.push('');
      lines.push(_t('reports.notesHeader', null, '📝 备注：', '📝 Notes:'));
      lines.push(r.notes.trim());
    }

    return lines.join('\n').trim();
  }

  const ReportsView = {
    _container: null,
    _renderVersion: 0,
    _aiInFlight: new Set(),
    _cardModes: {}, // 记忆每个周报的展示模式：'timeline'（默认）| 'project'

    mount(container) {
      this.cancelRender();
      this._container = container;
    },

    unmount() {
      this.cancelRender();
      this._container = null;
    },

    cancelRender() {
      this._renderVersion++;
    },

    async render(state) {
      if (!this._container) return;
      const container = this._container;
      const version = ++this._renderVersion;
      let reports;
      try {
        reports = await window.api.reports.list();
      } catch (error) {
        if (version === this._renderVersion) {
          window.ModuleApp.Toast?.show(_t('toast.loadFailed', { error: error.message || error }, '周报读取失败: ' + (error.message || error), 'Failed to load reports: ' + (error.message || error)), 'error');
        }
        return;
      }
      if (version !== this._renderVersion || container !== this._container
        || (state.view && state.view !== 'reports')) return;
      // The user may have started editing while the list request was pending.
      const active = document.activeElement;
      if (active?.id?.startsWith('reportNotesInput_') && container.contains(active)) return;

      const generateBar = `
        <div class="report-top-bar">
          <div class="report-top-actions">
            <button class="btn btn-primary" id="generateReportBtn">📊 ${_t('reports.generateCurrent', null, '生成本周周报', 'Generate This Week')}</button>
            <button class="btn btn-secondary" id="generateLastWeekReportBtn">📑 ${_t('reports.generateLastWeek', null, '生成上周周报', 'Generate Last Week')}</button>
          </div>
          <span class="report-top-hint">💡 ${_t('reports.topHint', null, '每周一可一键生成上周周报进行工作复盘', 'Generate last week\'s report every Monday for review')}</span>
        </div>`;

      if (reports.length === 0) {
        this._container.innerHTML = generateBar + `
          <div class="empty-state">
            <div class="empty-state-icon">📑</div>
            <div class="empty-state-title">${_t('reports.emptyTitle', null, '还没有周报数据', 'No reports yet')}</div>
            <div class="empty-state-hint">${_t('reports.empty', null, '点击上方按钮生成第一份周报', 'Click the button above to generate your first report.')}</div>
          </div>`;
        this._bindTopButtons();
        return;
      }

      const cardsHtml = reports.map(r => this._renderReportCard(r)).join('');
      this._container.innerHTML = generateBar + `<div class="reports-list">${cardsHtml}</div>`;
      this._bindTopButtons();
      this._bindCardEvents(state, reports);
    },

    _renderReportCard(r) {
      const start = _fmtDate(r.startDate);
      const end = _fmtDate(r.endDate);
      const weekId = r.weekId;
      const mode = this._cardModes[weekId] || 'timeline'; // 默认：时间足迹为主
      const entries = r.entries || [];
      const isEn = _locale() === 'en-US';

      // 1. 时间足迹视角 HTML
      let timelineHtml = '';
      if (entries.length === 0) {
        timelineHtml = `<div class="report-empty-entry">${_t('reports.noEntries', null, '本周暂无已完成任务', 'No completed tasks this week')}</div>`;
      } else {
        const sortedEntries = entries.slice().sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
        let lastDay = '';
        timelineHtml = sortedEntries.map(e => {
          const cur = _dayKey(e.completedAt);
          let header = '';
          if (cur !== lastDay) {
            header = `<div class="report-day-header">📅 ${_dayLabel(cur)}</div>`;
            lastDay = cur;
          }
          const levelTag = isEn
            ? (e.level === 0 ? 'Main' : `L${e.level}`)
            : (e.level === 0 ? '主' : e.level === 1 ? '一级' : e.level === 2 ? '二级' : e.level === 3 ? '三级' : '四级');
          return `
            ${header}
            <div class="report-timeline-item">
              <span class="report-entry-level l${e.level}">${levelTag}</span>
              <span class="report-timeline-text">
                ${e.parentContent ? `<span class="report-parent-tag">${_escapeHtml(e.parentContent)} › </span>` : ''}
                ${_escapeHtml(e.content)}
              </span>
              <span class="report-item-time">${_fmtDateShort(e.completedAt)}</span>
            </div>`;
        }).join('');
      }

      // 2. 项目归类视角 HTML
      let projectHtml = '';
      if (entries.length === 0) {
        projectHtml = `<div class="report-empty-entry">${_t('reports.noEntries', null, '本周暂无已完成任务', 'No completed tasks this week')}</div>`;
      } else {
        const projectGroups = new Map();
        for (const e of entries) {
          const groupName = _groupName(e);
          if (!projectGroups.has(groupName)) projectGroups.set(groupName, []);
          projectGroups.get(groupName).push(e);
        }
        projectHtml = Array.from(projectGroups.entries()).map(([groupName, items]) => `
          <div class="report-project-block">
            <div class="report-project-title">
              <span class="report-project-icon">📁</span>
              <span class="report-project-name">${_escapeHtml(groupName)}</span>
              <span class="report-project-badge">${_t('reports.itemsCount', { count: items.length }, `${items.length} 项`, `${items.length} items`)}</span>
            </div>
            <div class="report-project-items">
              ${items.map(e => `
                <div class="report-item-row">
                  <span class="report-item-check">✓</span>
                  <span class="report-item-text">${_escapeHtml(e.content)}</span>
                  <span class="report-item-time">${_fmtDateShort(e.completedAt)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('');
      }

      // 3. 统计图表 HTML（7 天每日产出柱状图 + 主/子任务分布）
      const dayNames = isEn
        ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        : ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      const dayCounts = [0, 0, 0, 0, 0, 0, 0];
      let mainCount = 0, subCount = 0;
      for (const e of entries) {
        if (e.completedAt) {
          const d = new Date(e.completedAt);
          const idx = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
          dayCounts[idx]++;
        }
        if (typeof e.level === 'number' && e.level > 0) subCount++;
        else mainCount++;
      }
      const maxDayCount = Math.max(...dayCounts, 1);
      const activeDays = dayCounts.filter(c => c > 0).length;

      let barsHtml = '';
      for (let i = 0; i < 7; i++) {
        const count = dayCounts[i];
        const heightPercent = count === 0 ? 0 : Math.max(12, Math.round((count / maxDayCount) * 100));
        const isPeak = count === maxDayCount && count > 0;
        barsHtml += `
          <div class="report-bar-col ${isPeak ? 'peak' : ''}">
            <span class="report-bar-val">${count > 0 ? count : ''}</span>
            <div class="report-bar-track">
              <div class="report-bar-fill ${isPeak ? 'peak' : ''}" style="height: ${heightPercent}%"></div>
            </div>
            <span class="report-bar-day">${dayNames[i]}</span>
          </div>`;
      }

      const chartHtml = `
        <div class="report-chart-box">
          <div class="report-chart-header">
            <span class="report-chart-title">📊 ${_t('reports.dailyTrend', null, '每日完成趋势', 'Daily Completion Trend')}</span>
            <div class="report-chart-tags">
              <span class="report-chart-tag">${_t('reports.activeDaysLabel', null, '活跃', 'Active')} <strong>${activeDays}</strong>/7 ${_t('reports.daysUnit', null, '天', 'd')}</span>
              ${mainCount > 0 ? `<span class="report-chart-tag">${_t('reports.mainTasksLabel', null, '主任务', 'Main')} <strong>${mainCount}</strong></span>` : ''}
              ${subCount > 0 ? `<span class="report-chart-tag">${_t('reports.subtasksLabel', null, '子任务', 'Subtasks')} <strong>${subCount}</strong></span>` : ''}
            </div>
          </div>
          <div class="report-chart-bars">${barsHtml}</div>
        </div>`;

      // 4. 备注区域 HTML（沉底）
      const hasNotes = r.notes && r.notes.trim().length > 0;

      return `
        <div class="report-card enhanced" data-week-id="${_escapeHtml(weekId)}">
          <!-- 头部信息 -->
          <div class="report-header">
            <div class="report-header-left">
              <div class="report-title-row">
                <span class="report-title">📑 ${_escapeHtml(weekId)}</span>
                <span class="report-date-badge">${start} ~ ${end}</span>
              </div>
              <div class="report-metrics-row">
                <span class="report-metric-pill primary">${_t('reports.completedLabel', null, '已完成', 'Completed')} <strong>${r.count}</strong> ${_t('reports.itemsUnit', null, '项', 'items')}</span>
              </div>
            </div>

            <!-- 操作按钮组 -->
            <div class="report-header-actions">
              <button class="btn btn-ghost btn-ai" data-report-ai="${_escapeHtml(weekId)}" title="${_t('reports.aiSummary', null, 'AI 总结', 'AI Summary')}"${this._aiInFlight.has(weekId) ? ' disabled' : ''}>✨ ${_t('reports.aiSummary', null, 'AI 总结', 'AI Summary')}</button>
              <button class="btn btn-ghost" data-report-copy="${_escapeHtml(weekId)}" title="${_t('reports.copyTooltip', null, '复制周报文本到剪贴板', 'Copy report text to clipboard')}">📋 ${_t('common.copy', null, '复制文本', 'Copy')}</button>
              <button class="btn btn-ghost" data-report-edit="${_escapeHtml(weekId)}" title="${_t('reports.editNotesTooltip', null, '编辑备注', 'Edit notes')}">📝 ${_t('reports.notesLabel', null, '备注', 'Notes')}</button>
              <button class="btn btn-ghost danger" data-report-delete="${_escapeHtml(weekId)}" title="${_t('reports.deleteReport', null, '删除周报', 'Delete Report')}">🗑 ${_t('common.delete', null, '删除', 'Delete')}</button>
            </div>
          </div>

          <!-- 完成明细（时间足迹为主） -->
          <div class="report-body-section">
            <div class="report-view-switcher">
              <span class="report-view-title">${_t('reports.detailsTitle', null, '完成明细', 'Completed Details')}</span>
              <div class="report-view-tabs">
                <button class="report-tab-btn ${mode === 'timeline' ? 'active' : ''}" data-switch-mode="timeline" data-week-id="${_escapeHtml(weekId)}">📅 ${_t('reports.viewTimeline', null, '按时间足迹', 'Timeline')}</button>
                <button class="report-tab-btn ${mode === 'project' ? 'active' : ''}" data-switch-mode="project" data-week-id="${_escapeHtml(weekId)}">📁 ${_t('reports.viewProject', null, '按项目归类', 'By Project')}</button>
              </div>
            </div>

            <div class="report-content-container">
              <div class="report-mode-view" style="${mode === 'timeline' ? '' : 'display:none;'}">${timelineHtml}</div>
              <div class="report-mode-view" style="${mode === 'project' ? '' : 'display:none;'}">${projectHtml}</div>
            </div>
          </div>

          <!-- 统计图表 -->
          ${chartHtml}

          <!-- 备注区块（置于底部） -->
          <div class="report-notes-box ${hasNotes ? 'has-notes' : 'empty-notes'}" id="reportNotesArea_${_escapeHtml(weekId)}">
            <div class="report-notes-header">
              <span class="report-notes-tag">📝 ${_t('reports.notesLabel', null, '备注', 'Notes')}</span>
              ${!hasNotes ? `<button class="report-add-notes-btn" data-report-edit="${_escapeHtml(weekId)}">+ ${_t('reports.addNotes', null, '添加备注', 'Add Notes')}</button>` : ''}
            </div>
            <div class="report-notes-content" id="reportNotesDisplay_${_escapeHtml(weekId)}" style="${hasNotes ? '' : 'display:none;'}">
              ${_escapeHtml(r.notes || '')}
            </div>
            <div class="report-notes-edit" id="reportNotesEdit_${_escapeHtml(weekId)}" style="display:none;">
              <textarea id="reportNotesInput_${_escapeHtml(weekId)}" rows="3" placeholder="${_t('reports.notesPlaceholder', null, '在此输入本周的总结、复盘或备注内容...', 'Write weekly summary, retrospective, or notes here...')}">${_escapeHtml(r.notes || '')}</textarea>
              <div class="report-notes-edit-actions">
                <button class="btn btn-ghost btn-sm" data-report-cancel="${_escapeHtml(weekId)}">${_t('common.cancel', null, '取消', 'Cancel')}</button>
                <button class="btn btn-primary btn-sm" data-report-save="${_escapeHtml(weekId)}">${_t('reports.saveNotes', null, '保存备注', 'Save Notes')}</button>
              </div>
            </div>
          </div>
        </div>`;
    },

    _bindTopButtons() {
      this._container.querySelector('#generateReportBtn')?.addEventListener('click', () => this._generate());
      this._container.querySelector('#generateLastWeekReportBtn')?.addEventListener('click', () => this._generateLastWeek());
    },

    _bindCardEvents(state, reports) {
      this._container.querySelectorAll('.report-card').forEach(card => {
        card.addEventListener('click', async (e) => {
          const weekId = card.dataset.weekId;
          const rep = reports.find(x => x.weekId === weekId);

          // 1. 切换视角（时间线 / 项目）
          const tabBtn = e.target.closest('[data-switch-mode]');
          if (tabBtn) {
            const nextMode = tabBtn.dataset.switchMode;
            this._cardModes[weekId] = nextMode;
            this.render(state);
            return;
          }

          // 1.5 AI 总结周报
          const aiBtn = e.target.closest('[data-report-ai]');
          if (aiBtn) {
            if (aiBtn.disabled || this._aiInFlight.has(weekId)) return;
            const currentRep = reports.find(r => r.weekId === weekId);
            if (!currentRep || (currentRep.count === 0 && (!currentRep.notes || !currentRep.notes.trim()))) {
              const ok = await window.ModuleApp?.Modal?.confirm?.({
                title: _t('reports.aiEmptyTitle', null, '周报内容为空', 'Empty Weekly Report'),
                message: _t(
                  'reports.aiEmptyConfirm',
                  null,
                  '本周暂无已完成任务且备注为空，暂无可总结的事实内容。是否仍要让 AI 生成下周规划建议？',
                  'No completed tasks and no notes for this week. Still let AI generate next-week planning suggestions?'
                ),
              });
              if (!ok) return;
            }
            const origHtml = aiBtn.innerHTML;
            const version = this._renderVersion;
            this._aiInFlight.add(weekId);
            aiBtn.disabled = true;
            aiBtn.classList.add('ai-loading');
            aiBtn.textContent = `⏳ ${_t('reports.aiGenerating', null, 'AI 正在生成总结...', 'Generating...')}`;
            try {
              const summary = await window.api.ai.generateWeeklyReport(weekId, _locale());
              if (version !== this._renderVersion || !this._container || state?.view !== 'reports') return;
              window.ModuleApp.Toast?.show(_t('reports.aiSuccess', null, 'AI 周报总结已生成', 'AI weekly summary generated'), 'success');
              this._showAiSummaryModal(weekId, String(summary || ''), state, currentRep);
            } catch (err) {
              if (version !== this._renderVersion || !this._container || state?.view !== 'reports') return;
              const msg = String(err?.message || err || '');
              if (msg.includes('ERR_API_KEY_MISSING')) {
                const ok = await window.ModuleApp?.Modal?.confirm?.({
                  title: _t('ai.apiKeyMissingTitle', null, '需要配置 API Key', 'API Key Required'),
                  message: _t('ai.apiKeyMissingConfirm', null, '尚未配置 AI API Key，是否立即打开设置进行配置？', 'AI API Key is not configured. Open Settings now?'),
                });
                if (ok) window.api?.app?.openSettings?.();
              } else if (msg.includes('ERR_INPUT_TOO_LARGE')) {
                window.ModuleApp.Toast?.show(_t('ai.inputTooLargeReport', null, '周报内容过长，请缩小范围后再试', 'Report content is too large; please narrow the scope and try again'), 'error');
              } else {
                window.ModuleApp.Toast?.show(_t('reports.aiFailed', { error: err?.message || err }, 'AI 周报生成失败: ' + (err?.message || err), 'AI report generation failed: ' + (err?.message || err)), 'error');
              }
            } finally {
              this._aiInFlight.delete(weekId);
              const currentBtn = this._container?.querySelector(`[data-report-ai="${CSS.escape(weekId)}"]`);
              if (currentBtn && currentBtn !== aiBtn) {
                currentBtn.disabled = false;
                currentBtn.classList.remove('ai-loading');
              }
              aiBtn.disabled = false;
              aiBtn.classList.remove('ai-loading');
              aiBtn.innerHTML = origHtml;
            }
            return;
          }

          // 2. 一键复制周报纯文本（走主进程 clipboard）
          const copyBtn = e.target.closest('[data-report-copy]');
          if (copyBtn && rep) {
            const text = _formatReportText(rep);
            try {
              await window.api.writeClipboard(text);
              window.ModuleApp.Toast.show(_t('toast.copySuccess', null, `已复制 ${weekId} 周报文本到剪贴板`, 'Copied to clipboard'), 'success');
            } catch (err) {
              window.ModuleApp.Toast.show(_t('toast.copyFailed', null, '复制失败，请手动复制', 'Copy failed'), 'error');
            }
            return;
          }

          // 3. 唤起编辑备注
          const editBtn = e.target.closest('[data-report-edit]');
          if (editBtn) {
            document.getElementById(`reportNotesDisplay_${weekId}`).style.display = 'none';
            document.getElementById(`reportNotesEdit_${weekId}`).style.display = 'block';
            document.getElementById(`reportNotesInput_${weekId}`).focus();
            return;
          }

          // 4. 取消编辑
          const cancelBtn = e.target.closest('[data-report-cancel]');
          if (cancelBtn) {
            this.render(state);
            return;
          }

          // 5. 保存备注
          const saveBtn = e.target.closest('[data-report-save]');
          if (saveBtn) {
            const notes = document.getElementById(`reportNotesInput_${weekId}`).value;
            try {
              await window.api.reports.update(weekId, { notes });
              window.ModuleApp.Toast.show(_t('toast.saveSuccess', null, '备注已保存', 'Saved successfully'), 'success');
              await window.ModuleApp.refreshUndoUI?.(); // 刷新撤销栏状态
              this.render(state);
            } catch (err) {
              window.ModuleApp.Toast.show(_t('toast.saveFailed', { error: err.message }, '保存失败: ' + err.message, 'Failed to save: ' + err.message), 'error');
            }
            return;
          }

          // 6. 删除周报
          const deleteBtn = e.target.closest('[data-report-delete]');
          if (deleteBtn) {
            const ok = await window.ModuleApp.Modal.confirm({
              title: _t('reports.deleteReport', null, '删除周报', 'Delete Report'),
              message: _t('reports.deleteConfirm', { weekId }, `确定要删除 ${weekId} 的周报吗？`, `Delete weekly report for ${weekId}?`)
            });
            if (ok) {
              try {
                await window.api.reports.delete(weekId);
                window.ModuleApp.Toast.show(_t('toast.deleteSuccess', null, '周报已删除', 'Deleted successfully'), 'success');
                await window.ModuleApp.refreshUndoUI?.(); // 激活撤销按钮显示 "撤回: 删除周报"
                this.render(state);
              } catch (err) {
                window.ModuleApp.Toast.show(_t('toast.deleteFailed', { error: err.message }, '删除失败: ' + err.message, 'Failed to delete: ' + err.message), 'error');
              }
            }
            return;
          }
        });
      });
    },

    _showAiSummaryModal(weekId, summaryText, state, rep) {
      let modal = document.getElementById('aiReportPreviewModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'aiReportPreviewModal';
        modal.className = 'modal';
        modal.hidden = true;
        document.body.appendChild(modal);
      }

      const existingNotes = (rep?.notes || '').trim();
      const hasExistingNotes = Boolean(existingNotes);
      const title = `✨ ${_t('reports.aiSummary', null, 'AI 总结', 'AI Summary')} — ${_escapeHtml(weekId)}`;
      const footerActions = hasExistingNotes
        ? `<button type="button" class="btn btn-danger" id="aiReportReplaceBtn">🔄 ${_t('reports.replaceNotes', null, '替换原备注', 'Replace Notes')}</button>
           <button type="button" class="btn btn-primary" id="aiReportAppendBtn">➕ ${_t('reports.appendToNotes', null, '追加到备注', 'Append to Notes')}</button>`
        : `<button type="button" class="btn btn-primary" id="aiReportApplyBtn">📝 ${_t('reports.applyToNotes', null, '填入备注', 'Apply to Notes')}</button>`;

      modal.innerHTML = `
        <div class="modal-backdrop" data-ai-close></div>
        <div class="modal-card ai-modal-card">
          <div class="modal-header">
            <h2>${title}</h2>
            <button type="button" class="btn-close" data-ai-close>✕</button>
          </div>
          <div class="modal-body">
            <div class="ai-md-toggle" style="display:flex;gap:6px;align-items:center;">
              <button type="button" class="btn btn-sm btn-primary" data-ai-tab="preview">${_t('reports.aiPreview', null, '预览', 'Preview')}</button>
              <button type="button" class="btn btn-sm btn-ghost" data-ai-tab="edit">${_t('reports.aiEdit', null, '编辑', 'Edit')}</button>
            </div>
            <div class="ai-md-preview" id="aiSummaryPreview" style="min-height:220px;max-height:46vh;overflow-y:auto;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--bg-card);font-size:13px;line-height:1.6;">${_renderSimpleMarkdown(summaryText)}</div>
            <textarea class="ai-preview-textarea" id="aiSummaryTextarea" rows="12" style="display:none;">${_escapeHtml(summaryText)}</textarea>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" data-ai-close>${_t('common.close', null, '关闭', 'Close')}</button>
            <button type="button" class="btn btn-secondary" id="aiReportCopyBtn">📋 ${_t('common.copy', null, '复制', 'Copy')}</button>
            ${footerActions}
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

      const previewEl = modal.querySelector('#aiSummaryPreview');
      const textareaEl = modal.querySelector('#aiSummaryTextarea');
      const previewTabBtn = modal.querySelector('[data-ai-tab="preview"]');
      const editTabBtn = modal.querySelector('[data-ai-tab="edit"]');

      previewTabBtn?.addEventListener('click', () => {
        if (previewEl && textareaEl) {
          previewEl.innerHTML = _renderSimpleMarkdown(textareaEl.value);
          previewEl.style.display = '';
          textareaEl.style.display = 'none';
        }
        previewTabBtn.classList.remove('btn-ghost');
        previewTabBtn.classList.add('btn-primary');
        editTabBtn?.classList.remove('btn-primary');
        editTabBtn?.classList.add('btn-ghost');
      });

      editTabBtn?.addEventListener('click', () => {
        if (previewEl && textareaEl) {
          previewEl.style.display = 'none';
          textareaEl.style.display = '';
          textareaEl.focus();
        }
        editTabBtn.classList.remove('btn-ghost');
        editTabBtn.classList.add('btn-primary');
        previewTabBtn?.classList.remove('btn-primary');
        previewTabBtn?.classList.add('btn-ghost');
      });

      const copyBtn = modal.querySelector('#aiReportCopyBtn');
      copyBtn?.addEventListener('click', async () => {
        const raw = textareaEl?.value || '';
        const plain = raw.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1');
        try {
          await window.api.writeClipboard(plain);
          window.ModuleApp.Toast?.show(_t('toast.copySuccess', null, '已复制到剪贴板', 'Copied to clipboard'), 'success');
          if (copyBtn) {
            const origText = copyBtn.textContent;
            copyBtn.textContent = `✓ ${_t('common.copied', null, '已复制', 'Copied')}`;
            setTimeout(() => { copyBtn.textContent = origText; }, 1500);
          }
        } catch (_) {
          window.ModuleApp.Toast?.show(_t('toast.copyFailed', null, '复制失败', 'Copy failed'), 'error');
        }
      });

      const saveNotes = async (notes, btn, successMsg) => {
        if (btn) btn.disabled = true;
        try {
          await window.api.reports.update(weekId, { notes });
          await window.ModuleApp.refreshUndoUI?.();
          window.ModuleApp.Toast?.show(successMsg, 'success');
          closeModal();
          this.render(state);
        } catch (err) {
          window.ModuleApp.Toast?.show(_t('toast.saveFailed', { error: err?.message || err }, '保存失败: ' + (err?.message || err), 'Failed to save: ' + (err?.message || err)), 'error');
          if (btn) btn.disabled = false;
        }
      };

      const appendBtn = modal.querySelector('#aiReportAppendBtn');
      appendBtn?.addEventListener('click', async () => {
        const summary = textareaEl?.value || '';
        const combined = `${rep.notes.trimEnd()}\n\n---\n${summary}`;
        await saveNotes(combined, appendBtn, _t('reports.appendedSuccess', null, '已追加到备注', 'Appended to notes'));
      });

      const replaceBtn = modal.querySelector('#aiReportReplaceBtn');
      replaceBtn?.addEventListener('click', async () => {
        const ok = await window.ModuleApp?.Modal?.confirm?.({
          title: _t('reports.replaceNotesTitle', null, '确认替换原备注', 'Confirm Replace Notes'),
          message: _t('reports.replaceNotesConfirm', null, '当前周报已有备注内容，替换将会覆盖原有备注。确定要替换吗？', 'Existing notes will be overwritten by the AI summary. Continue?'),
        });
        if (!ok) return;
        const notes = textareaEl?.value || '';
        await saveNotes(notes, replaceBtn, _t('reports.replacedSuccess', null, '已替换原备注', 'Notes replaced'));
      });

      const applyBtn = modal.querySelector('#aiReportApplyBtn');
      applyBtn?.addEventListener('click', async () => {
        const notes = textareaEl?.value || '';
        await saveNotes(notes, applyBtn, _t('toast.saveSuccess', null, '已填入备注', 'Applied to notes'));
      });
    },

    async _generate() {
      const btn = this._container?.querySelector('#generateReportBtn');
      if (btn?.disabled) return;
      if (btn) btn.disabled = true;
      try {
        const state = window.ModuleApp.State ? window.ModuleApp.State.state : null;
        const weekId = await window.api.reports.currentWeekId();
        const report = await window.api.reports.generate(weekId);
        window.ModuleApp.Toast.show(_t('reports.generatedToast', { weekId, count: report.count }, `周报 ${weekId} 已生成（${report.count} 项完成）`, `Report ${weekId} generated (${report.count} completed)`), 'success');
        await this.render(state);
      } catch (err) {
        window.ModuleApp.Toast?.show(_t('reports.generateFailed', { error: err?.message || err }, '生成周报失败: ' + (err?.message || err), 'Failed to generate report: ' + (err?.message || err)), 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    },

    async _generateLastWeek() {
      const btn = this._container?.querySelector('#generateLastWeekReportBtn');
      if (btn?.disabled) return;
      if (btn) btn.disabled = true;
      try {
        const state = window.ModuleApp.State ? window.ModuleApp.State.state : null;
        const weekId = await window.api.reports.lastWeekId();
        const report = await window.api.reports.generate(weekId);
        window.ModuleApp.Toast.show(_t('reports.generatedLastWeekToast', { weekId, count: report.count }, `上周周报 ${weekId} 已生成（${report.count} 项完成）`, `Last week report ${weekId} generated (${report.count} completed)`), 'success');
        await this.render(state);
      } catch (err) {
        window.ModuleApp.Toast?.show(_t('reports.generateFailed', { error: err?.message || err }, '生成周报失败: ' + (err?.message || err), 'Failed to generate report: ' + (err?.message || err)), 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.ReportsView = ReportsView;
})();
