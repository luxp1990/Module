// Module — 截止日期分桶（本地日，禁止 UTC 日）
// 主进程 require；渲染进程挂 window.ModuleApp.DeadlineBuckets
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.ModuleApp = window.ModuleApp || {};
    window.ModuleApp.DeadlineBuckets = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const OVERDUE_LIST_CAP = 50;

  /** 本地日历日 YYYY-MM-DD（不用 toISOString 直接切） */
  function localDateStr(d) {
    const dt = d instanceof Date ? d : new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function addLocalDays(dateStr, days) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return localDateStr(dt);
  }

  function formatParentChain(task, taskMap) {
    if (!task) return '';
    const names = [];
    let cur = task;
    const guard = new Set();
    while (cur && cur.parentId && !guard.has(cur.id)) {
      guard.add(cur.id);
      const p = taskMap.get(cur.parentId);
      if (!p) break;
      names.unshift(p.content || '');
      cur = p;
    }
    names.push(task.content || '');
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ' › ' + names[1];
    // 顶层 + … + 自身
    return names[0] + ' › … › ' + names[names.length - 1];
  }

  /**
   * @param {object[]} tasks
   * @param {string} [todayStr]
   * @returns {{ today: object[], tomorrow: object[], overdue: object[], todayStr: string, tomorrowStr: string }}
   */
  function bucketTasks(tasks, todayStr) {
    const today = todayStr || localDateStr();
    const tomorrow = addLocalDays(today, 1);
    const bucketToday = [];
    const bucketTomorrow = [];
    const bucketOverdue = [];
    for (const t of tasks || []) {
      if (!t || t.completed || !t.deadline) continue;
      if (t.deadline === today) bucketToday.push(t);
      else if (t.deadline === tomorrow) bucketTomorrow.push(t);
      else if (t.deadline < today) bucketOverdue.push(t);
    }
    bucketOverdue.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
    const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
    bucketToday.sort(byOrder);
    bucketTomorrow.sort(byOrder);
    return {
      today: bucketToday,
      tomorrow: bucketTomorrow,
      overdue: bucketOverdue,
      todayStr: today,
      tomorrowStr: tomorrow,
    };
  }

  function toRows(list, taskMap) {
    return (list || []).map((t) => ({
      id: t.id,
      content: t.content || '',
      deadline: t.deadline || '',
      chain: formatParentChain(t, taskMap),
    }));
  }

  /**
   * @param {object[]} tasks 已按需过滤（全局或 scope）的全量任务（含完成项亦可，分桶会跳过）
   * @param {{ mode?: 'full'|'near'|'overdue', overdueCap?: number, emptyCheer?: boolean, locale?: string }} opts
   */
  function buildPayload(tasks, opts) {
    const mode = (opts && opts.mode) || 'full';
    const overdueCap = (opts && opts.overdueCap != null) ? opts.overdueCap : OVERDUE_LIST_CAP;
    const emptyCheer = !!(opts && opts.emptyCheer);
    const i18n = (typeof window !== 'undefined' && window.ModuleApp && window.ModuleApp.I18n) ? window.ModuleApp.I18n : null;
    const locale = (opts && opts.locale) || (i18n ? i18n.getLocale() : 'zh-CN');
    const isEn = locale === 'en-US';
    const tr = (key, zh, en) => (i18n && i18n.hasKey(key, locale)) ? i18n.t(key) : (isEn ? en : zh);

    const all = tasks || [];
    const taskMap = new Map(all.map((t) => [t.id, t]));
    const b = bucketTasks(all);
    const overdueTotal = b.overdue.length;
    const overdueShown = b.overdue.slice(0, overdueCap);
    const overdueMore = Math.max(0, overdueTotal - overdueShown.length);

    let sections = [];
    if (mode === 'full' || mode === 'near') {
      sections.push({ key: 'today', title: tr('deadline.dueToday', '今天到期', 'Due today'), rows: toRows(b.today, taskMap) });
      sections.push({ key: 'tomorrow', title: tr('deadline.dueTomorrow', '明天到期', 'Due tomorrow'), rows: toRows(b.tomorrow, taskMap) });
    }
    if (mode === 'full' || mode === 'overdue') {
      sections.push({
        key: 'overdue',
        title: tr('deadline.overdue', '已逾期', 'Overdue'),
        rows: toRows(overdueShown, taskMap),
        more: overdueMore,
      });
    }
    if (mode === 'near') {
      // 近两日不含逾期块
      sections = sections.filter((s) => s.key === 'today' || s.key === 'tomorrow');
    }
    if (mode === 'overdue') {
      sections = sections.filter((s) => s.key === 'overdue');
    }

    const totalNear = b.today.length + b.tomorrow.length;
    const totalAll = totalNear + overdueTotal;
    const totalVisible = sections.reduce((n, s) => n + s.rows.length, 0);
    const headlineCount = mode === 'near' ? totalNear
      : mode === 'overdue' ? overdueTotal
      : totalAll;

    let emptyMessage = null;
    if (totalVisible === 0 && overdueMore === 0) {
      if (mode === 'full' && emptyCheer) {
        emptyMessage = isEn ? 'All tasks are completed, time to wrap up!' : '所有任务都已完成，快下班吧！';
      } else if (mode === 'near') {
        emptyMessage = isEn ? 'No tasks due in the next two days' : '近两日没有到期任务';
      } else if (mode === 'overdue') {
        emptyMessage = isEn ? 'No overdue tasks' : '没有延期任务';
      } else {
        emptyMessage = isEn ? 'No tasks need attention' : '没有需要关注的任务';
      }
    }

    return {
      mode,
      todayStr: b.todayStr,
      tomorrowStr: b.tomorrowStr,
      sections,
      counts: {
        today: b.today.length,
        tomorrow: b.tomorrow.length,
        overdue: overdueTotal,
        near: totalNear,
        all: headlineCount,
      },
      emptyMessage,
      emptyCheer: !!(emptyCheer && mode === 'full' && totalAll === 0),
    };
  }

  function countNearTwoDays(tasks) {
    const b = bucketTasks(tasks);
    return b.today.length + b.tomorrow.length;
  }

  function countOverdue(tasks) {
    return bucketTasks(tasks).overdue.length;
  }

  return {
    OVERDUE_LIST_CAP,
    localDateStr,
    addLocalDays,
    bucketTasks,
    buildPayload,
    formatParentChain,
    countNearTwoDays,
    countOverdue,
  };
});
