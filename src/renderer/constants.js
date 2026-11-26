// Module — 冶金级常量（从 app.js 提取的硬编码字面量）
(function() {
  const AppConstants = {
    // 视图类型（与 data-view 属性、switchView() 路由一一对应）
    VIEWS: {
      HIERARCHY: 'hierarchy',
      DEADLINE: 'deadline',
      GANTT: 'gantt',
      COMPLETED: 'completed',
      REPORTS: 'reports',
      NOTES: 'notes'
    },

    // 优先级（与 select#taskPriority 的 value 一致）
    PRIORITIES: ['p0', 'p1', 'p2'],
    PRIORITY_LABELS: { p0: 'P0 紧急', p1: 'P1 重要', p2: 'P2 普通' },
    PRIORITY_EMOJIS: { p0: '🔴', p1: '🟠', p2: '🟡' },

    // 任务状态（与 select#taskStatus 的 value 一致）
    STATUSES: ['todo', 'progress', 'blocked', 'review'],
    STATUS_LABELS: { todo: '待办', progress: '进行中', blocked: '阻塞', review: '审核中' },
    STATUS_EMOJIS: { todo: '📋', progress: '🔄', blocked: '🚫', review: '👁' },

    // 日期格式
    DATE_FORMAT: 'YYYY-MM-DD',

    // 层级约束
    MAX_LEVEL: 4,          // 最大子任务层数（0=主任务，1-4=子任务；共五级，不含六级）
    DRAG_DEPTH_THRESHOLD: 80, // 拖拽插入线深度阈值（px）

    // 甘特图缩放级别
    GANTT_ZOOM: { DAY: 'day', WEEK: 'week', MONTH: 'month', QUARTER: 'quarter' },

    // 自动规划配置
    AUTO_PLAN_DEFAULT: false,
    RETENTION_DAYS_DEFAULT: 30,
    WEEK_REPORT_DAY_DEFAULT: 1, // 周一

    // IPC 事件类型（Delta Sync action 标签）
    IPC_ACTIONS: {
      TASK_CREATED: 'TASK_CREATED',
      TASK_COMPLETED: 'TASK_COMPLETED',
      TASK_UNCOMPLETED: 'TASK_UNCOMPLETED',
      TASK_UPDATED: 'TASK_UPDATED',
      TASK_DELETED: 'TASK_DELETED',
      TASKS_BATCH_CREATED: 'TASKS_BATCH_CREATED',
      TASKS_BATCH_DELETED: 'TASKS_BATCH_DELETED',
      TASK_REORDERED: 'TASK_REORDERED',
      NOTE_CREATED: 'NOTE_CREATED',
      NOTE_UPDATED: 'NOTE_UPDATED',
      NOTE_DELETED: 'NOTE_DELETED',
      NOTES_REORDERED: 'NOTES_REORDERED',
      DATA_UNDO: 'DATA_UNDO',
      DATA_IMPORTED: 'DATA_IMPORTED',
      CONFIG_UPDATED: 'CONFIG_UPDATED'
    },

    // 便签颜色
    NOTE_COLORS: ['#fef9c3', '#dcfce7', '#dbeafe', '#fce7f3', '#f3e8ff', '#ffedd5']
  };

  // 挂载到 window
  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.Constants = AppConstants;
})();
