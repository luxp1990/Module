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
    if (days < 0) return '已逾期 ' + Math.abs(days) + ' 天';
    if (days === 0) return '今天截止';
    if (days === 1) return '明天截止';
    return '剩余 ' + days + ' 天';
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
    const dClass = deadlineClass(task.deadline);
    const overdueClass = dClass === 'danger' ? 'is-overdue' : (dClass === 'warning' ? 'is-due-soon' : '');
    const dLabel = deadlineLabel(task.deadline);
    const hasNotes = task.notes && task.notes.trim().length > 0;
    const toggle = hasChildren
      ? '<span class="task-toggle" data-toggle="' + task.id + '">' + (isExpanded ? '▼' : '▶') + '</span>'
      : '<span class="task-toggle empty">·</span>';
    let dBadge = '';
    if (task.deadline) {
      const lbl = (dClass === 'danger' || dClass === 'warning')
        ? dLabel
        : '还有 ' + daysFromNow(task.deadline) + ' 天';
      dBadge = '<span class="deadline ' + dClass + '">' + lbl + ' · ' + fmtDateShort(task.deadline) + '</span>';
    }
    const notesIcon = hasNotes
      ? '<span class="notes-indicator" data-notes="' + task.id + '" title="查看备注">📝</span>'
      : '';
    const pLabels = { p0: 'P0', p1: 'P1', p2: 'P2' };
    const sLabels = { todo: '待办', progress: '进行中', blocked: '阻塞', review: '审核中' };
    const pBadge = task.priority
      ? '<span class="task-priority-badge ' + task.priority + '">🔴 ' + (pLabels[task.priority] || task.priority) + '</span>'
      : '';
    const sBadge = task.status
      ? '<span class="task-status-badge ' + task.status + '">' + (sLabels[task.status] || task.status) + '</span>'
      : '';
    const addChildBtn = level < window.ModuleApp.Constants.MAX_LEVEL
      ? '<button class="task-action-btn" data-add-child="' + task.id + '" title="添加子任务">＋</button>'
      : '';

    return '<div class="task-row level-' + Math.min(level, 4) + ' ' + overdueClass + '"' +
      ' data-id="' + task.id + '" data-level="' + level + '" draggable="true"' +
      ' oncontextmenu="event.preventDefault();window.ModuleApp.ContextMenu&&window.ModuleApp.ContextMenu.show(\'' + task.id + '\',event.clientX,event.clientY)">' +
      '<span class="task-handle" title="拖动调整顺序">⋮⋮</span>' +
      toggle +
      '<div class="task-content">' +
        '<span class="task-content-text">' + highlightMatch(task.content, searchQuery) + '</span>' +
      '</div>' +
      '<div class="task-meta">' +
        pBadge + sBadge + dBadge + notesIcon +
      '</div>' +
      '<div class="task-actions">' +
        addChildBtn +
        '<button class="task-action-btn" data-edit="' + task.id + '" title="编辑">✎</button>' +
        '<button class="task-action-btn complete" data-complete="' + task.id + '" title="完成">✓</button>' +
        '<button class="task-action-btn delete" data-delete="' + task.id + '" title="删除">🗑</button>' +
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
