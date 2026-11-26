// Module — 视图：周报视图 (时间足迹为主 + 统计图表 + 备注沉底)
// 基于 1.7.7 + 周报修复（终态收尾/上周按钮/时区/undo/删除墓碑）之上重构：
//   - 默认【时间足迹】视角，可按周一到周日查看完成流转
//   - 【每日完成趋势】柱状图 + 主/子任务分布统计
//   - 备注区沉底，精简为「📝 备注」
//   - 一键复制周报文本（走主进程 clipboard，Electron file:// 下可靠）
(function() {
  function _escapeHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Calendar dates stay literal; legacy timestamp boundaries must be converted to local time.
  function _fmtDate(iso) {
    if (!iso) return '';
    const s = String(iso);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return m[1] + '年' + m[2] + '月' + m[3] + '日';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '年' + String(d.getMonth()+1).padStart(2,'0') + '月' + String(d.getDate()).padStart(2,'0') + '日';
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
    const w = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()];
    return m + '/' + d + ' 周' + w;
  }

  // 任务归属分组名（项目归类视角用）
  function _groupName(e) {
    if (e.parentContent) return e.parentContent;
    return e.level === 0 ? '独立主任务' : '其他事项';
  }

  // 格式化一键复制的周报文本（时间足迹排版，备注沉底）
  function _formatReportText(r) {
    const start = _fmtDate(r.startDate);
    const end = _fmtDate(r.endDate);
    const lines = [
      '【' + r.weekId + ' 周报】（' + start + ' ~ ' + end + '）',
      '本周完成：' + r.count + ' 项工作',
      ''
    ];

    lines.push('📋 工作完成明细：');
    if (!r.entries || r.entries.length === 0) {
      lines.push('（本周暂无已完成任务）');
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
      lines.push('📝 备注：');
      lines.push(r.notes.trim());
    }

    return lines.join('\n').trim();
  }

  const ReportsView = {
    _container: null,
    _renderVersion: 0,
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
        if (version === this._renderVersion) window.ModuleApp.Toast?.show('周报读取失败: ' + (error.message || error), 'error');
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
            <button class="btn btn-primary" id="generateReportBtn">📊 生成本周周报</button>
            <button class="btn btn-secondary" id="generateLastWeekReportBtn">📑 生成上周周报</button>
          </div>
          <span class="report-top-hint">💡 每周一可一键生成上周周报进行工作复盘</span>
        </div>`;

      if (reports.length === 0) {
        this._container.innerHTML = generateBar + `
          <div class="empty-state">
            <div class="empty-state-icon">📑</div>
            <div class="empty-state-title">还没有周报数据</div>
            <div class="empty-state-hint">点击上方按钮生成第一份周报</div>
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

      // 1. 时间足迹视角 HTML
      let timelineHtml = '';
      if (entries.length === 0) {
        timelineHtml = `<div class="report-empty-entry">本周暂无已完成任务</div>`;
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
          const levelTag = e.level === 0 ? '主' : e.level === 1 ? '一级' : e.level === 2 ? '二级' : e.level === 3 ? '三级' : '四级';
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
        projectHtml = `<div class="report-empty-entry">本周暂无已完成任务</div>`;
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
              <span class="report-project-badge">${items.length} 项</span>
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
      const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
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
            <span class="report-chart-title">📊 每日完成趋势</span>
            <div class="report-chart-tags">
              <span class="report-chart-tag">活跃 <strong>${activeDays}</strong>/7 天</span>
              ${mainCount > 0 ? `<span class="report-chart-tag">主任务 <strong>${mainCount}</strong></span>` : ''}
              ${subCount > 0 ? `<span class="report-chart-tag">子任务 <strong>${subCount}</strong></span>` : ''}
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
                <span class="report-metric-pill primary">已完成 <strong>${r.count}</strong> 项</span>
              </div>
            </div>

            <!-- 操作按钮组 -->
            <div class="report-header-actions">
              <button class="btn btn-ghost" data-report-copy="${_escapeHtml(weekId)}" title="复制周报文本到剪贴板">📋 复制文本</button>
              <button class="btn btn-ghost" data-report-edit="${_escapeHtml(weekId)}" title="编辑备注">📝 备注</button>
              <button class="btn btn-ghost danger" data-report-delete="${_escapeHtml(weekId)}" title="删除此周报">🗑 删除</button>
            </div>
          </div>

          <!-- 完成明细（时间足迹为主） -->
          <div class="report-body-section">
            <div class="report-view-switcher">
              <span class="report-view-title">完成明细</span>
              <div class="report-view-tabs">
                <button class="report-tab-btn ${mode === 'timeline' ? 'active' : ''}" data-switch-mode="timeline" data-week-id="${_escapeHtml(weekId)}">📅 按时间足迹</button>
                <button class="report-tab-btn ${mode === 'project' ? 'active' : ''}" data-switch-mode="project" data-week-id="${_escapeHtml(weekId)}">📁 按项目归类</button>
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
              <span class="report-notes-tag">📝 备注</span>
              ${!hasNotes ? `<button class="report-add-notes-btn" data-report-edit="${_escapeHtml(weekId)}">+ 添加备注</button>` : ''}
            </div>
            <div class="report-notes-content" id="reportNotesDisplay_${_escapeHtml(weekId)}" style="${hasNotes ? '' : 'display:none;'}">
              ${_escapeHtml(r.notes || '')}
            </div>
            <div class="report-notes-edit" id="reportNotesEdit_${_escapeHtml(weekId)}" style="display:none;">
              <textarea id="reportNotesInput_${_escapeHtml(weekId)}" rows="3" placeholder="在此输入本周的总结、复盘或备注内容...">${_escapeHtml(r.notes || '')}</textarea>
              <div class="report-notes-edit-actions">
                <button class="btn btn-ghost btn-sm" data-report-cancel="${_escapeHtml(weekId)}">取消</button>
                <button class="btn btn-primary btn-sm" data-report-save="${_escapeHtml(weekId)}">保存备注</button>
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

          // 2. 一键复制周报纯文本（走主进程 clipboard）
          const copyBtn = e.target.closest('[data-report-copy]');
          if (copyBtn && rep) {
            const text = _formatReportText(rep);
            try {
              await window.api.writeClipboard(text);
              window.ModuleApp.Toast.show(`已复制 ${weekId} 周报文本到剪贴板`, 'success');
            } catch (err) {
              window.ModuleApp.Toast.show('复制失败，请手动复制', 'error');
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
              window.ModuleApp.Toast.show('备注已保存', 'success');
              await window.ModuleApp.refreshUndoUI?.(); // 刷新撤销栏状态
              this.render(state);
            } catch (err) {
              window.ModuleApp.Toast.show('保存失败: ' + err.message, 'error');
            }
            return;
          }

          // 6. 删除周报
          const deleteBtn = e.target.closest('[data-report-delete]');
          if (deleteBtn) {
            const ok = await window.ModuleApp.Modal.confirm({
              title: '删除周报',
              message: `确定要删除 ${weekId} 的周报吗？`
            });
            if (ok) {
              try {
                await window.api.reports.delete(weekId);
                window.ModuleApp.Toast.show('周报已删除', 'success');
                await window.ModuleApp.refreshUndoUI?.(); // 激活撤销按钮显示 "撤回: 删除周报"
                this.render(state);
              } catch (err) {
                window.ModuleApp.Toast.show('删除失败: ' + err.message, 'error');
              }
            }
            return;
          }
        });
      });
    },

    async _generate() {
      const state = window.ModuleApp.State ? window.ModuleApp.State.state : null;
      const weekId = await window.api.reports.currentWeekId();
      const report = await window.api.reports.generate(weekId);
      window.ModuleApp.Toast.show('周报 ' + weekId + ' 已生成（' + report.count + ' 项完成）', 'success');
      await this.render(state);
    },

    async _generateLastWeek() {
      const state = window.ModuleApp.State ? window.ModuleApp.State.state : null;
      const weekId = await window.api.reports.lastWeekId();
      const report = await window.api.reports.generate(weekId);
      window.ModuleApp.Toast.show('上周周报 ' + weekId + ' 已生成（' + report.count + ' 项完成）', 'success');
      await this.render(state);
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.ReportsView = ReportsView;
})();
