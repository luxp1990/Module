// api-bridge.js: Dual Engine Bridge for Electron & Tauri 2.0
// When running in Electron, preload.js provides window.api directly.
// When running in Tauri 2.0, this bridge creates window.api mapping to Tauri invoke & event.
(function () {
  'use strict';
  if (window.api) return;
  if (!window.__TAURI__) return;

  const core = window.__TAURI__.core || window.__TAURI__;
  const invoke = core.invoke.bind(core);
  const event = window.__TAURI__.event;
  const listen = event ? event.listen.bind(event) : () => {};

  window.api = {
    tasks: {
      getAll: () => invoke('tasks_get_all'),
      getActive: () => invoke('tasks_get_active'),
      getCompleted: () => invoke('tasks_get_completed'),
      create: (task) => invoke('tasks_create', { task }),
      batchCreate: (tasks) => invoke('tasks_batch_create', { tasks }),
      update: (id, updates) => invoke('tasks_update', { id, updates }),
      delete: (id) => invoke('tasks_delete', { id }),
      complete: (id) => invoke('tasks_complete', { id }),
      uncomplete: (id) => invoke('tasks_uncomplete', { id }),
      batchUncomplete: (ids) => invoke('tasks_batch_uncomplete', { ids }),
      batchComplete: (ids) => invoke('tasks_batch_complete', { ids }),
      batchDelete: (ids) => invoke('tasks_batch_delete', { ids }),
      batchSetPriority: (ids, priority) => invoke('tasks_batch_set_priority', { ids, priority }),
      reorder: (items) => invoke('tasks_reorder', { items }),
      cleanup: () => invoke('tasks_cleanup'),
    },
    reports: {
      list: () => invoke('reports_list'),
      get: (weekId) => invoke('reports_get', { weekId }),
      generate: (weekId) => invoke('reports_generate', { weekId }),
      currentWeekId: () => invoke('reports_current_week_id'),
      lastWeekId: () => invoke('reports_last_week_id'),
      delete: (weekId) => invoke('reports_delete', { weekId }),
      update: (weekId, updates) => invoke('reports_update', { weekId, updates }),
    },
    writeClipboard: (text) => invoke('clipboard_write', { text }),
    config: {
      get: () => invoke('config_get'),
      update: (updates) => invoke('config_update', { updates }),
    },
    gantt: {
      data: () => invoke('gantt_data'),
      exportExcel: (projectScopeIds) => invoke('gantt_export_excel', {
        projectScopeIds: Array.isArray(projectScopeIds) ? projectScopeIds : [],
      }),
      exportCsv: (projectScopeIds) => invoke('gantt_export_csv', {
        projectScopeIds: Array.isArray(projectScopeIds) ? projectScopeIds : [],
      }),
      requestSavePath: () => invoke('gantt_request_save_path'),
      writeImageBuffer: (filePath, arrayBuffer, token) => {
        const bytes = Array.from(new Uint8Array(arrayBuffer));
        return invoke('gantt_write_image_buffer', { filePath, data: bytes, token });
      },
    },
    backups: {
      list: () => invoke('backups_list'),
      restore: (id) => invoke('backups_restore', { id }),
    },
    undo: {
      list: () => invoke('undo_list'),
      canUndo: () => invoke('undo_can_undo'),
      undo: () => invoke('undo_undo'),
      clear: () => invoke('undo_clear'),
    },
    debug: {
      dataPath: () => invoke('debug_data_path'),
    },
    dialog: {
      confirm: (options) => invoke('dialog_confirm', { options: options || {} }),
    },
    data: {
      export: () => invoke('data_export'),
      readFile: () => invoke('data_read_file'),
      import: (snapshot, mode) => invoke('data_import', { snapshot, mode }),
    },
    notes: {
      list: () => invoke('notes_list'),
      create: (input) => invoke('notes_create', { input }),
      update: (id, updates) => invoke('notes_update', { id, updates }),
      delete: (id) => invoke('notes_delete', { id }),
      reorder: (items) => invoke('notes_reorder', { items }),
    },
    widget: {
      toggle: () => invoke('widget_toggle'),
      status: () => invoke('widget_status'),
      focusMain: () => invoke('widget_focus_main'),
      setAlwaysOnTop: (flag) => invoke('widget_set_always_on_top', { flag }),
      getPinned: () => invoke('widget_get_pinned'),
    },
    hotkey: {
      set: (key) => invoke('hotkey_set', { key }),
      get: () => invoke('hotkey_get'),
    },
    reminder: {
      getPayload: (opts) => invoke('reminder_get_payload', { opts: opts || {} }),
      openPanel: (opts) => invoke('reminder_open_panel', { opts: opts || {} }),
      focusTask: (id) => invoke('reminder_focus_task', { id }),
      onShow: (callback) => {
        listen('reminder-show', (e) => callback(e.payload));
      },
    },
    window: {
      hide: () => invoke('window_hide'),
      close: () => invoke('window_hide'),
    },
    app: {
      version: () => invoke('app_version'),
      updateTrayLanguage: (lang) => invoke('app_update_tray_language', { lang }),
      openSettings: () => invoke('app_open_settings'),
    },
    ai: {
      getConfig: () => invoke('ai_get_config'),
      saveConfig: (config) => invoke('ai_save_config', { input: config }),
      listModels: (config) => invoke('ai_list_models', { input: config || null }),
      testConnection: (config) => invoke('ai_test_connection', { input: config || null }),
      generateWeeklyReport: (weekId, language) => invoke('ai_generate_weekly_report', { weekId, language }),
      breakdownTask: (taskId, instruction, maxTasks, language) => invoke('ai_breakdown_task', { taskId, instruction, maxTasks, language }),
      notesToTasks: (noteId, language) => invoke('ai_notes_to_tasks', { noteId, language }),
    },
    onDataChange: (callback) => {
      listen('data-changed', (e) => callback(e.payload));
    },
    onReminderNavigate: (callback) => {
      listen('reminder-navigate-task', (e) => callback(e.payload));
    },
  };
})();
