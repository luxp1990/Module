// Preload 脚本 — 暴露给渲染进程的安全 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  tasks: {
    getAll: () => ipcRenderer.invoke('tasks:getAll'),
    getActive: () => ipcRenderer.invoke('tasks:getActive'),
    getCompleted: () => ipcRenderer.invoke('tasks:getCompleted'),
    create: (task) => ipcRenderer.invoke('tasks:create', task),
    batchCreate: (tasks) => ipcRenderer.invoke('tasks:batchCreate', tasks),
    update: (id, updates) => ipcRenderer.invoke('tasks:update', id, updates),
    delete: (id) => ipcRenderer.invoke('tasks:delete', id),
    complete: (id) => ipcRenderer.invoke('tasks:complete', id),
    uncomplete: (id) => ipcRenderer.invoke('tasks:uncomplete', id),
    batchUncomplete: (ids) => ipcRenderer.invoke('tasks:batchUncomplete', ids),
    batchComplete: (ids) => ipcRenderer.invoke('tasks:batchComplete', ids),
    batchDelete: (ids) => ipcRenderer.invoke('tasks:batchDelete', ids),
    batchSetPriority: (ids, priority) => ipcRenderer.invoke('tasks:batchSetPriority', ids, priority),
    reorder: (items) => ipcRenderer.invoke('tasks:reorder', items),
    cleanup: () => ipcRenderer.invoke('tasks:cleanup'),
  },
  reports: {
    list: () => ipcRenderer.invoke('reports:list'),
    get: (weekId) => ipcRenderer.invoke('reports:get', weekId),
    generate: (weekId) => ipcRenderer.invoke('reports:generate', weekId),
    currentWeekId: () => ipcRenderer.invoke('reports:currentWeekId'),
    lastWeekId: () => ipcRenderer.invoke('reports:lastWeekId'),
    delete: (weekId) => ipcRenderer.invoke('reports:delete', weekId),
    update: (weekId, updates) => ipcRenderer.invoke('reports:update', weekId, updates),
  },
  // 剪贴板是通用能力，挂顶层 api（reports.js 调 window.api.writeClipboard）
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    update: (updates) => ipcRenderer.invoke('config:update', updates),
  },
  gantt: {
    data: () => ipcRenderer.invoke('gantt:data'),
    exportExcel: () => ipcRenderer.invoke('gantt:exportExcel'),
    // 二进制流导出:主进程给路径 -> 前端截图转 ArrayBuffer -> IPC 直写磁盘（审计 1.2：带回 token）
    requestSavePath: () => ipcRenderer.invoke('gantt:requestSavePath'),
    writeImageBuffer: (filePath, arrayBuffer, token) =>
      ipcRenderer.invoke('gantt:writeImageBuffer', filePath, arrayBuffer, token),
  },
  undo: {
    list: () => ipcRenderer.invoke('undo:list'),
    canUndo: () => ipcRenderer.invoke('undo:canUndo'),
    undo: () => ipcRenderer.invoke('undo:undo'),
    clear: () => ipcRenderer.invoke('undo:clear'),
  },
  debug: {
    dataPath: () => ipcRenderer.invoke('debug:dataPath'),
  },
  dialog: {
    confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
  },
  data: {
    export: () => ipcRenderer.invoke('data:export'),
    readFile: () => ipcRenderer.invoke('data:readFile'),
    import: (snapshot, mode) => ipcRenderer.invoke('data:import', snapshot, mode),
  },
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    create: (input) => ipcRenderer.invoke('notes:create', input),
    update: (id, updates) => ipcRenderer.invoke('notes:update', id, updates),
    delete: (id) => ipcRenderer.invoke('notes:delete', id),
    reorder: (items) => ipcRenderer.invoke('notes:reorder', items),
  },
  widget: {
    toggle: () => ipcRenderer.invoke('widget:toggle'),
    status: () => ipcRenderer.invoke('widget:status'),
    focusMain: () => ipcRenderer.invoke('widget:focusMain'),
    setAlwaysOnTop: (flag) => ipcRenderer.invoke('widget:setAlwaysOnTop', flag),
    getPinned: () => ipcRenderer.invoke('widget:getPinned'),
  },
  hotkey: {
    set: (key) => ipcRenderer.invoke('hotkey:set', key),
    get: () => ipcRenderer.invoke('hotkey:get'),
  },
  reminder: {
    getPayload: (opts) => ipcRenderer.invoke('reminder:getPayload', opts || {}),
    openPanel: (opts) => ipcRenderer.invoke('reminder:openPanel', opts || {}),
    focusTask: (id) => ipcRenderer.invoke('reminder:focusTask', id),
    onShow: (callback) => {
      ipcRenderer.on('reminder:show', (event, opts) => callback(opts));
    },
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },
  onDataChange: (callback) => {
    // Delta Sync: data = { source: 'main'|'widget', patch: { action, id, ids, payload }|null }
    // patch === null 时走全量 reload；patch !== null 时增量处理
    ipcRenderer.on('data-changed', (event, data) => callback(data));
  },
  onReminderNavigate: (callback) => {
    ipcRenderer.on('reminder:navigate-task', (event, id) => callback(id));
  },
});
