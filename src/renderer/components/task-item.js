// Module — 组件：任务行
(function() {
  // ===== 渲染工具函数（与 app.js 保持同步） =====
  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function fmtDateShort(iso) {
    if (!iso) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [, m, d] = iso.split('-');
      return m + '/' + d;
    }
    const d = new Date(iso);
    return (d.getMonth()+1) + '/' + d.getDate();
  }

  function daysFromNow(iso) {
    const U = window.ModuleApp && window.ModuleApp.Utils;
    if (U && typeof U.daysFromNow === 'function') return U.daysFromNow(iso);
    if (!iso) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let end;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [y, m, d] = iso.split('-').map(Number);
      end = new Date(y, m - 1, d);
    } else {
      end = new Date(iso);
      end.setHours(0, 0, 0, 0);
    }
    return Math.round((end - today) / 86400000);
  }

  function deadlineClass(iso) {
    if (!iso) return '';
    const days = daysFromNow(iso);
    if (days === null) return '';
    if (days < 0) return 'danger';
    if (days <= 3) return 'warning';
    return '';
  }

  function deadlineLabel(iso) {
    if (!iso) return '';
    const days = daysFromNow(iso);
    if (days === null) return '';
    const I18n = window.ModuleApp?.I18n;
    if (days < 0) return I18n?.t('deadline.daysOverdue', { days: Math.abs(days) }) || ('已逾期 ' + Math.abs(days) + ' 天');
    if (days === 0) return I18n?.t('deadline.dueToday') || '今天截止';
    if (days === 1) return I18n?.t('deadline.tomorrow') || '明天截止';
    return I18n?.t('deadline.daysLeft', { days }) || ('剩余 ' + days + ' 天');
  }

  function highlightMatch(text, query) {
    if (!text) return '';
    if (!query) return escapeHtml(text);
    const lc = String(text).toLowerCase();
    let result = '';
    let i = 0;
    while (i < text.length) {
      const idx = lc.indexOf(query, i);
      if (idx === -1) {
        result += escapeHtml(text.slice(i));
        break;
      }
      result += escapeHtml(text.slice(i, idx));
      result += '<mark class="search-highlight">' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>';
      i = idx + query.length;
    }
    return result;
  }

  // ===== 任务行渲染 =====
  function renderRow(task, level, hasChildren, isExpanded, searchQuery) {
    const I18n = window.ModuleApp?.I18n;
    const isEn = I18n?.getLocale?.() === 'en-US';
    const dClass = deadlineClass(task.deadline);
    const overdueClass = dClass === 'danger' ? 'is-overdue' : (dClass === 'warning' ? 'is-due-soon' : '');
    const dLabel = deadlineLabel(task.deadline);
    const hasNotes = task.notes && task.notes.trim().length > 0;
    const toggle = hasChildren
      ? '<span class="task-toggle" data-toggle="' + task.id + '">' + (isExpanded ? '▼' : '▶') + '</span>'
      : '<span class="task-toggle empty">·</span>';
    let dBadge = '';
    if (task.deadline) {
      const days = daysFromNow(task.deadline);
      const lbl = (dClass === 'danger' || dClass === 'warning')
        ? dLabel
        : (I18n?.t('deadline.daysLeft', { days }) || ('还有 ' + days + ' 天'));
      dBadge = '<span class="deadline ' + dClass + '">' + lbl + ' · ' + fmtDateShort(task.deadline) + '</span>';
    }
    const notesTitle = isEn ? 'View notes' : '查看备注';
    const notesIcon = hasNotes
      ? '<span class="notes-indicator" data-notes="' + task.id + '" title="' + notesTitle + '">📝</span>'
      : '';
    const pLabels = {
      p0: I18n?.t('priority.p0Short') || 'P0',
      p1: I18n?.t('priority.p1Short') || 'P1',
      p2: I18n?.t('priority.p2Short') || 'P2',
    };
    const sLabels = {
      todo: I18n?.t('status.todo') || '待办',
      progress: I18n?.t('status.progress') || '进行中',
      blocked: I18n?.t('status.blocked') || '阻塞',
      review: I18n?.t('status.review') || '审核中',
    };
    const pBadge = task.priority
      ? '<span class="task-priority-badge ' + task.priority + '">🔴 ' + (pLabels[task.priority] || task.priority) + '</span>'
      : '';
    const sBadge = task.status
      ? '<span class="task-status-badge ' + task.status + '">' + (sLabels[task.status] || task.status) + '</span>'
      : '';
    const addChildTitle = I18n?.t('hierarchy.addSubtask') || '添加子任务';
    const addChildBtn = level < window.ModuleApp.Constants.MAX_LEVEL
      ? '<button class="task-action-btn" data-add-child="' + task.id + '" title="' + addChildTitle + '">＋</button>'
      : '';
    const aiBreakdownTitle = I18n?.t('context.aiBreakdown') || 'AI 拆解子任务';
    const aiBreakdownBtn = !task.completed && level < window.ModuleApp.Constants.MAX_LEVEL
      ? '<button class="task-action-btn task-action-ai" data-ai-breakdown="' + task.id + '" data-action="ai-breakdown" title="' + aiBreakdownTitle + '">✨</button>'
      : '';

    return '<div class="task-row level-' + Math.min(level, 4) + ' ' + overdueClass + '"' +
      ' data-id="' + task.id + '" data-level="' + level + '" draggable="true"' +
      ' oncontextmenu="event.preventDefault();window.ModuleApp.ContextMenu&&window.ModuleApp.ContextMenu.show(\'' + task.id + '\',event.clientX,event.clientY)">' +
      '<span class="task-handle" title="' + (I18n?.t('hierarchy.dragHint') || '拖动调整顺序') + '">⋮⋮</span>' +
      toggle +
      '<div class="task-content">' +
        '<span class="task-content-text">' + highlightMatch(task.content, searchQuery) + '</span>' +
      '</div>' +
      '<div class="task-meta">' +
        pBadge + sBadge + dBadge + notesIcon +
      '</div>' +
      '<div class="task-actions">' +
        addChildBtn +
        aiBreakdownBtn +
        '<button class="task-action-btn" data-edit="' + task.id + '" title="' + (I18n?.t('common.edit') || '编辑') + '">✎</button>' +
        '<button class="task-action-btn complete" data-complete="' + task.id + '" title="' + (I18n?.t('common.done') || '完成') + '">✓</button>' +
        '<button class="task-action-btn delete" data-delete="' + task.id + '" title="' + (I18n?.t('common.delete') || '删除') + '">🗑</button>' +
      '</div>' +
    '</div>';
  }

  const TaskItem = {
    render: renderRow,
    helpers: {
      escapeHtml,
      highlightMatch,
      deadlineClass,
      deadlineLabel,
      daysFromNow,
      fmtDateShort,
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.TaskItem = TaskItem;
})();
