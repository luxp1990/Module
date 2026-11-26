// ==================== 日期边界标准化 ====================
// 所有涉及日期计算的入口必须调用这里，禁止裸用 new Date() + setHours/getDay
// Data Boundary Normalization：在数据进出系统的边界彻底清洗日期，绝不让时分秒尾数蔓延

/**
 * 归零到当天 00:00:00.000，剔除不可见的时分秒尾数
 * @param {Date|string} dateInput
 * @returns {Date} 干净的当日零点
 */
function startOfDay(dateInput) {
  const d = dateInput instanceof Date ? new Date(dateInput) : new Date(dateInput);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 计算两个日期相差多少天（整数，纯日历，不受时分秒干扰）
 * @param {Date|string} dateLeft
 * @param {Date|string} dateRight
 * @returns {number} dateLeft - dateRight 的天数差
 */
function diffInDays(dateLeft, dateRight) {
  const d1 = startOfDay(dateLeft);
  const d2 = startOfDay(dateRight);
  return Math.round((d1 - d2) / 86400000);
}

/**
 * 判断是否为周末（周六或周日），支持自定义一周起点
 * @param {Date} date
 * @param {number} weekStart 0=周日(北美) 1=周一(中国/欧洲) 6=周六(中东)
 * @returns {boolean}
 */
function isWeekendDay(date, weekStart = 1) {
  const dow = date.getDay(); // 0=周日
  if (weekStart === 1) return dow === 0 || dow === 6; // 周一起点：周六、周日为周末
  if (weekStart === 0) return dow === 0 || dow === 6; // 周日起点：同义
  if (weekStart === 6) return dow === 5 || dow === 6; // 周六起点：周五、周六
  return false;
}

/**
 * 计算某日期在其所在周中的偏移天数（从周起点算起第几天）
 * 支持任意一周起点，语义明确，不会产生魔法数字
 * @param {Date} date
 * @param {number} weekStart 0=周日 1=周一(默认)
 * @returns {number} 0~6
 */
function getWeekDayOffset(date, weekStart = 1) {
  const dow = date.getDay(); // 0=周日
  return (dow + 7 - weekStart) % 7;
}

/**
 * 获取指定日期所在周的周一（weekStart=1 时）或周日（weekStart=0 时）
 * @param {Date} date
 * @param {number} weekStart 0=周日 1=周一(默认)
 * @returns {Date}
 */
function getWeekStart(date, weekStart = 1) {
  const d = new Date(date);
  const offset = getWeekDayOffset(d, weekStart);
  d.setDate(d.getDate() - offset);
  return startOfDay(d);
}

// ==================== 甘特图专用工具函数 ====================

/**
 * 生成日期数组（用于甘特图列头）
 * @param {Date} minDate 区间起点（归一化为当日零点）
 * @param {Date} maxDate 区间终点（归一化为当日零点）
 * @returns {Date[]} 每日一格的日期数组
 */
function generateDateRange(minDate, maxDate) {
  const start = startOfDay(minDate);
  const end = startOfDay(maxDate);
  const dates = [];
  const cur = new Date(start);
  while (cur <= end) {
    dates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

/**
 * 计算甘特条块在某列索引下的偏移像素值（用于 SVG weekend 错位修复）
 * @param {Date} colDate 该列代表的日期
 * @param {Date} minDate 甘特图整体起点
 * @param {number} dayWidth 每天宽度（px）
 * @param {number} weekStart 一周起点
 * @returns {number} 应向左偏移的 px 值
 */
function getGanttColOffset(colDate, minDate, dayWidth, weekStart = 1) {
  const offsetDays = getWeekDayOffset(startOfDay(colDate), weekStart);
  return -offsetDays * dayWidth;
}

// ==================== 命名空间输出 ====================
// 将标准化工具函数统一暴露至主作用域，保证甘特图等模块可正确读取
// 审计 2.4：合并所有组件重复定义的 escapeHtml/daysFromNow/deadlineClass/highlightMatch
window.ModuleApp = window.ModuleApp || {};
window.ModuleApp.Utils = {
  // 日期
  startOfDay,
  diffInDays,
  isWeekendDay,
  getWeekDayOffset,
  getWeekStart,
  generateDateRange,
  getGanttColOffset,
  // HTML 安全
  escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  },
  // 纯日期 YYYY-MM-DD 解析（避免 new Date("2026-01-01") UTC 偏移）
  parseLocalDate(iso) {
    if (!iso) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    return new Date(iso);
  },
  fmtDateShort(iso) {
    if (!iso) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [, m, d] = iso.split('-');
      return m + '/' + d;
    }
    const d = new Date(iso);
    return (d.getMonth()+1) + '/' + d.getDate();
  },
  fmtDateChinese(iso) {
    if (!iso) return '';
    const d = this.parseLocalDate(iso) || new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return y + '年' + m + '月' + day + '日';
  },
  // 日历日差：两端都归零到本地 00:00，用 round；禁止 end=23:59:59 + ceil（今天会变成 0.999→1「明天」）
  daysFromNow(iso) {
    if (!iso) return null;
    const end = this.parseLocalDate(iso);
    if (!end || Number.isNaN(end.getTime())) return null;
    return diffInDays(startOfDay(end), startOfDay(new Date()));
  },
  deadlineClass(iso) {
    if (!iso) return '';
    const days = this.daysFromNow(iso);
    if (days === null) return '';
    if (days < 0) return 'danger';
    if (days <= 3) return 'warning';
    return '';
  },
  deadlineLabel(iso) {
    if (!iso) return '';
    const days = this.daysFromNow(iso);
    if (days === null) return '';
    if (days < 0) return '已逾期 ' + Math.abs(days) + ' 天';
    if (days === 0) return '今天截止';
    if (days === 1) return '明天截止';
    return '剩余 ' + days + ' 天';
  },
  highlightMatch(text, query) {
    if (!text) return '';
    if (!query) return this.escapeHtml(text);
    const lc = String(text).toLowerCase();
    let result = '';
    let i = 0;
    while (i < text.length) {
      const idx = lc.indexOf(query, i);
      if (idx === -1) {
        result += this.escapeHtml(text.slice(i));
        break;
      }
      result += this.escapeHtml(text.slice(i, idx));
      result += '<mark>' + this.escapeHtml(text.slice(idx, idx + query.length)) + '</mark>';
      i = idx + query.length;
    }
    return result;
  }
};
