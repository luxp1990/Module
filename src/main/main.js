// Module - Electron main entry
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, globalShortcut, screen, powerMonitor, Notification } = require('electron');
const DeadlineBuckets = require('../shared/deadline-buckets');

// 解析纯日期 YYYY-MM-DD 为本地时间(避免 new Date("2026-01-01") 被 UTC 解析导致西半球偏移一天)
function parseLocalDate(iso) {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(iso);
}

// 获取本地日期字符串（解决 toISOString() 返回 UTC 导致清晨文件名是昨天的问题）
function getLocalDateStr() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().slice(0, 10);
}
function getLocalStamp() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().slice(0, 19).replace(/[T:]/g, '-');
}

// ===== IPC 输入校验 =====
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0 && v.length < 1000;
}
function isString(v) { return typeof v === 'string'; }
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}
function sanitizeTaskInput(task) {
  if (!isPlainObject(task)) return null;
  if (typeof task.content !== 'string') return null;
  const content = String(task.content).slice(0, 10000);
  return {
    content,
    deadline: (isString(task.deadline) && /^\d{4}-\d{2}-\d{2}/.test(task.deadline)) ? task.deadline : undefined,
    startDate: (isString(task.startDate) && /^\d{4}-\d{2}-\d{2}/.test(task.startDate)) ? task.startDate : undefined,
    priority: (isString(task.priority) && ['p0','p1','p2'].includes(task.priority)) ? task.priority : undefined,
    status: (isString(task.status)) ? task.status.slice(0, 100) : undefined,
    notes: (isString(task.notes)) ? task.notes.slice(0, 50000) : undefined,
    parentId: isNonEmptyString(task.parentId) ? task.parentId : undefined,
  };
}
function sanitizeId(id) {
  return isNonEmptyString(id) ? id : null;
}
function sanitizeIdArray(ids) {
  if (!Array.isArray(ids)) return null;
  return ids.filter(isNonEmptyString).slice(0, 10000);
}

// 单实例锁定:双击图标时激活已有窗口,而非启动第二个实例
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 第二个实例启动时,直接退出即可
  app.quit();
} else {
  app.on('second-instance', () => {
    // 收到第二个实例启动信号,显示主窗口
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}
const path = require('path');
const fs = require('fs');
const DataStore = require('./data-store');
const ExcelJS = require('exceljs');
const { startLocalIpcServer, stopLocalIpcServer } = require('./local-ipc');

let mainWindow = null;
let store = null;

// ==================== 性能 & 内存优化配置 ====================
// app ready 之前不要打开任何窗口
// 注：disableHardwareAcceleration: Electron 33.4 + Windows 避免崩溃
// GPU  chromium 崩溃（规避显卡兼容问题）
//   默认禁用 GPU 加速,保证渲染稳定性
// app.disableHardwareAcceleration();
// 实测保留默认 GPU:4 进程,内存约 ~280MB,保证渲染安全

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'Module',
    backgroundColor: '#f8fafc',
    // 禁用硬件加速,避免 Windows 平台 Chromium GPU 崩溃
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 单进程渲染:
      backgroundThrottling: false,  // 禁用后台节流
      spellcheck: false,            // 禁用拼写检查
      enableWebSQL: false,
      v8CacheOptions: 'none',       // 禁用 v8 代码缓存(防止缓存污染导致更新失效,每次启动干净)
    },
  });

  // //
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 启动后自动打开 DevTools
  // mainWindow.webContents.openDevTools();

  // //
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // //
  const userDataDir = path.join(app.getPath('userData'));
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // //
  const dataFile = path.join(userDataDir, 'tasks-data.json');
  store = new DataStore(dataFile);
  store.load();

  // ==================== 本地 IPC 服务 (供 MCP Server 与 CLI 接入) ====================
  startLocalIpcServer(store, broadcastDataChanged, app, { pushUndo });

  createWindow();

  // ==================== 系统托盘 ====================
  createTray();

  // ==================== 热键偏好加载 ====================
  // //
  try {
    const prefFile = path.join(app.getPath('userData'), 'hotkey-pref.json');
    if (fs.existsSync(prefFile)) {
      const pref = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
      if (pref.hotkey) currentHotkey = pref.hotkey;
    }
  } catch (e) { /* 使用默认值 */ }
  registerWidgetHotkey();

  // ==================== 定时任务 ====================
  app.isQuitting = false;

  // (定时查询,自动生成周报并驻留托盘)
  //每晚 20:00 检查,强制要求设置"下班打卡时间 17:30"
  tryAutoWeeklyReport();
  tryDailyReminder();

  // Bug-系统休眠定时器失效修复:用 powerMonitor 监听系统唤醒事件,
  // 解决 setInterval 在 Sleep/Hibernate 后被挂起或堆积的问题
  powerMonitor.on('resume', () => {
    console.log('[System] Woke up from sleep, checking reports...');
    tryAutoWeeklyReport();
    tryDailyReminder();
  });
  powerMonitor.on('unlock-screen', () => {
    tryAutoWeeklyReport();
    tryDailyReminder();
  });

  // 兜底:不休眠一直亮屏场景,2 小时低频心跳
  setInterval(() => {
    tryAutoWeeklyReport();
    tryDailyReminder();
  }, 2 * 60 * 60 * 1000);
  // 提醒：每分钟检查一次是否到点（比 2h 心跳更准）
  setInterval(tryDailyReminder, 60 * 1000);
});

// ==================== 系统托盘 ====================
let tray = null;
let currentHotkey = 'CommandOrControl+Shift+M';  // //

// 加载托盘图标:白底透明背景
function loadTrayIcon(iconPath, size) {
  size = size || 16;
  let img;
  try {
    img = nativeImage.createFromPath(iconPath);
  } catch (e) {
    console.warn('[Tray] Failed to load icon:', e.message);
    return null;
  }
  if (img.isEmpty()) return null;
  const w0 = img.getSize().width, h0 = img.getSize().height;
  // Bug-托盘图标消失修复:上一行乱码把 const resized 误注释成同一行,
  // 导致下面 return resized 抛出 ReferenceError,createTray() 中断,托盘图标消失。
  // 直接缩放,保留原图所有颜色(白色就是白色)
  const resized = img.resize({ width: size, height: size, quality: 'best' });
  console.log('[Tray] Icon loaded: ' + w0 + 'x' + h0 + ' → ' + size + 'x' + size + ' (no transparency processing)');
  return resized;
}

// 用字符 "M" 作为图标主样式 + 浅色背景
function generateTrayIcon(size) {
  const { nativeImage } = require('electron');
  size = size || 16;
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  // 背景色 #1e293b
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      pixels[idx] = 30;     // R
      pixels[idx + 1] = 41;  // G
      pixels[idx + 2] = 59;  // B
      pixels[idx + 3] = 255; // A
    }
  }
  // 画一个放大后的 "M" 字母,浅蓝/白字体 #a5b4fc
  function setPixel(x, y) {
    if (x >= 0 && x < size && y >= 0 && y < size) {
      const idx = (Math.round(y) * size + Math.round(x)) * 4;
      pixels[idx] = 165;     // R
      pixels[idx + 1] = 180; // G
      pixels[idx + 2] = 252; // B
      pixels[idx + 3] = 255; // A
    }
  }
  // 画单条 M 形状:两条竖线+倒 V
  const pad = Math.max(1, Math.floor(size * 0.15));
  const w = Math.max(2, Math.floor(size * 0.12)); // //
  const top = pad;
  const bottom = size - pad - 1;
  const midY = Math.floor((top + bottom) / 2);
  // //
  for (let y = top; y <= bottom; y++) {
    for (let dx = 0; dx < w; dx++) setPixel(pad + dx, y);
  }
  // //
  for (let y = top; y <= bottom; y++) {
    for (let dx = 0; dx < w; dx++) setPixel(size - pad - 1 - dx, y);
  }
  // 画倒 V:左斜线和右斜线在底部交汇
  for (let i = 0; i <= (midY - top); i++) {
    const ratio = i / (midY - top || 1);
    // //
    const lx = pad + w + Math.round(ratio * (size / 2 - pad - w - 1));
    for (let dx = 0; dx < w; dx++) setPixel(lx + dx, top + i);
    // //
    const rx = size - pad - w - 1 - Math.round(ratio * (size / 2 - pad - w - 1));
    for (let dx = 0; dx < w; dx++) setPixel(rx + dx, top + i);
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function buildTrayMenu() {
  // Bug-幽灵图标/配置损坏修复:即使 json 损坏导致 currentHotkey 不是字符串,
  // .replace() 也会抛出 TypeError 使整个右键菜单崩溃,加类型兜底。
  const safeHotkey = (typeof currentHotkey === 'string' && currentHotkey) ? currentHotkey : 'CommandOrControl+Shift+M';
  const hotkeyLabel = safeHotkey.replace('CommandOrControl', 'Ctrl').split('+').filter(Boolean).join(' + ');
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '桌面组件',
      click: () => {
        if (widgetWindow && !widgetWindow.isDestroyed()) {
          widgetWindow.close();
        } else {
          createWidgetWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: '⚙️ 设置 (' + hotkeyLabel + ')',
      click: () => openSettingsWindow(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const iconPath = require('path').join(__dirname, '..', 'renderer', 'icon.png');
  let trayIcon = loadTrayIcon(iconPath, 16);
  if (!trayIcon || trayIcon.isEmpty()) {
    // 加载或处理失败时,回退到代码生成的托盘图标
    console.warn('[Tray] icon.png load/process failed, using generated fallback');
    trayIcon = generateTrayIcon(16);
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('肥仔任务管理器');
  tray.setContextMenu(buildTrayMenu());

  // 双击托盘图标,显示主窗口
  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// //
let settingsWindow = null;

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 440,
    height: 640,
    title: '设置',
    resizable: false,
    parent: null,
    modal: false,
    frame: true,
    backgroundColor: '#1e293b',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ==================== 每日任务提醒 ====================
let reminderWindow = null;
let reminderSession = { mode: 'full', useScope: false };

function filterTasksByProjectScopeMain(tasks, scopeIds) {
  if (!Array.isArray(scopeIds) || scopeIds.length === 0) return tasks || [];
  const ids = scopeIds.filter(id => typeof id === 'string' && id);
  if (ids.length === 0) return tasks || [];
  const list = tasks || [];
  const children = new Map();
  for (const t of list) {
    if (!t.parentId) continue;
    if (!children.has(t.parentId)) children.set(t.parentId, []);
    children.get(t.parentId).push(t.id);
  }
  const visible = new Set();
  const stack = ids.slice();
  while (stack.length) {
    const id = stack.pop();
    if (visible.has(id)) continue;
    visible.add(id);
    const kids = children.get(id);
    if (kids) for (const k of kids) stack.push(k);
  }
  return list.filter(t => visible.has(t.id));
}

function buildReminderPayload(opts) {
  const mode = (opts && opts.mode) || 'full';
  const useScope = !!(opts && opts.useScope);
  let tasks = store.data.tasks || [];
  if (useScope) {
    const cfg = store.getConfig();
    tasks = filterTasksByProjectScopeMain(tasks, cfg.projectScopeIds || []);
  }
  return DeadlineBuckets.buildPayload(tasks, {
    mode,
    emptyCheer: mode === 'full',
  });
}

function ensureMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  createWindow();
  return mainWindow;
}

function openReminderWindow(opts = {}) {
  const mode = opts.mode || 'full';
  const useScope = !!opts.useScope;
  reminderSession = { mode, useScope };

  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.webContents.send('reminder:show', reminderSession);
    if (reminderWindow.isMinimized()) reminderWindow.restore();
    reminderWindow.show();
    reminderWindow.focus();
    return reminderWindow;
  }

  reminderWindow = new BrowserWindow({
    width: 420,
    height: 560,
    title: '任务提醒',
    resizable: true,
    minimizable: true,
    parent: null,
    modal: false,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#1e293b',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 去掉 File/Edit/View 应用菜单（无用且占视觉）
  reminderWindow.setMenu(null);
  reminderWindow.loadFile(path.join(__dirname, '../renderer/reminder.html'), {
    query: { mode, scope: useScope ? '1' : '0' },
  });
  reminderWindow.on('closed', () => { reminderWindow = null; });
  return reminderWindow;
}

function showDailyReminderNotification(payload) {
  if (!Notification.isSupported()) return;
  try {
    const empty = !payload || !payload.counts || payload.counts.all === 0;
    const n = new Notification({
      title: 'Module 任务提醒',
      body: empty
        ? '所有任务都已完成，快下班吧！'
        : `有 ${payload.counts.all} 项需要关注`,
    });
    n.on('click', () => {
      openReminderWindow({ mode: 'full', useScope: false });
    });
    n.show();
  } catch (e) {
    console.warn('[daily-reminder] Notification failed:', e.message);
  }
}

function tryDailyReminder() {
  if (!store || store._loadError) return;
  try {
    const cfg = store.getConfig();
    if (!cfg.dailyReminderEnabled) return;

    const today = DeadlineBuckets.localDateStr();
    if (cfg.lastDailyReminderDate === today) return;

    const hour = Number.isFinite(cfg.dailyReminderHour) ? cfg.dailyReminderHour : 17;
    const minute = Number.isFinite(cfg.dailyReminderMinute) ? cfg.dailyReminderMinute : 0;
    const now = new Date();
    const pastDue = now.getHours() > hour
      || (now.getHours() === hour && now.getMinutes() >= minute);
    if (!pastDue) return;

    const payload = buildReminderPayload({ mode: 'full', useScope: false });
    store.updateConfig({ lastDailyReminderDate: today });
    openReminderWindow({ mode: 'full', useScope: false });
    showDailyReminderNotification(payload);
    console.log('[daily-reminder] fired ' + today + ' at local ' + hour + ':' + String(minute).padStart(2, '0'));
  } catch (e) {
    console.error('[daily-reminder] failed:', e.message);
  }
}

// 注册/注销全局快捷键
function registerWidgetHotkey() {
  globalShortcut.unregisterAll();
  return globalShortcut.register(currentHotkey, () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.close();
    } else {
      createWidgetWindow();
    }
  });
}

// //
// Bug-104 自杀式覆盖修复:旧逻辑是先覆盖 currentHotkey 再 register,失败时返回错误但变量已被污染。
// 下次启动 registerWidgetHotkey 会拿这个无效键再注册一次,导致原本好用的旧快捷键也失效。
// 修复:先记住 oldKey,失败时回滚,并恢复原来的全局快捷键注册。
ipcMain.handle('hotkey:set', (event, newKey) => {
  // Bug-4 修复：拒绝系统级保留快捷键，防止用户不小心屏蔽了 OS 关键操作
  const RESERVED_KEYS = ['Alt+F4', 'CommandOrControl+Alt+Delete', 'PrintScreen', 'Control+Alt+Delete', 'Ctrl+Alt+Delete'];
  if (RESERVED_KEYS.some(r => newKey && newKey.toLowerCase().replace(/\s+/g, '').includes(r.toLowerCase().replace(/\s+/g, '')))) {
    return { ok: false, error: `快捷键"${newKey}"为系统保留，不可设置` };
  }
  const oldKey = currentHotkey;
  currentHotkey = newKey || currentHotkey;
  const ok = registerWidgetHotkey();
  if (!ok) {
    // 注册失败:把 currentHotkey 回滚到旧值,并尝试重新注册旧快捷键(确保系统内有一个能用的)
    currentHotkey = oldKey;
    registerWidgetHotkey();
    if (tray) tray.setContextMenu(buildTrayMenu());
    return { ok: false, hotkey: currentHotkey, error: `全局快捷键"${newKey}" 注册失败，已回滚到"${currentHotkey}"` };
  }
  // 注册成功:刷新托盘 + 持久化新快捷键
  if (tray) tray.setContextMenu(buildTrayMenu());
  try {
    const prefFile = path.join(app.getPath('userData'), 'hotkey-pref.json');
    fs.writeFileSync(prefFile, JSON.stringify({ hotkey: currentHotkey }), 'utf8');
  } catch (e) { /* ignore */ }
  return { ok: true, hotkey: currentHotkey };
});

// //
ipcMain.handle('hotkey:get', () => {
  return { hotkey: currentHotkey };
});

// //
app.on('will-quit', () => {
  stopLocalIpcServer();
  globalShortcut.unregisterAll();
  // Bug-102 截断式数据丢失修复:data-store.js 用 300ms 防抖延迟优化高频 I/O,
  // 但用户 Alt+F4 或右键退出时,定时器会被直接杀死,防抖缓冲里的脏数据丢失。
  // 必须在 will-quit(进程退出前最后一个同步 hook)强制 flush 落盘。
  if (store && typeof store.flush === 'function') {
    store.flush();
  }
  // Bug-幽灵图标修复:确保退出时销毁托盘实例,防止进程快速退出时残留死图标
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
});

// ==================== 自动周报与补漏收尾修复 ====================
// 1) 周五 17:30 后/周末：生成本周周报（非终态快照，跨周后由第 2 步收尾重生成）
// 2) 进入新一周后：若上周周报缺失，或是在上周结束前生成的旧快照(generatedAt <= 上周日 23:59:59.999)，
//    则重新统计生成终态周报，把周五晚间与周末完成的任务完整纳入（仅首次需要时执行一次）
function tryAutoWeeklyReport() {
  if (!store || store._loadError) return;
  try {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const min = now.getMinutes();

    // 1. 周五 17:30 之后或周末：触发生成本周周报
    const isFridayAfterCutoff = (day === 5 && (hour > 17 || (hour === 17 && min >= 30)));
    const isWeekend = (day === 6 || day === 0);
    if (isFridayAfterCutoff || isWeekend) {
      const weekId = store.getWeekId(now);
      // 若该周报已被用户显式删除，则不自动重新创建（避免删除后立即复活）
      if (!store.getWeeklyReport(weekId) && !store.isWeeklyReportDeleted(weekId)) {
        store.generateWeeklyReport(weekId);
        broadcastDataChanged({ action: 'REPORT_CREATED', id: weekId });
        console.log('[weekly-report] auto-generated ' + weekId + ' at ' + now.toISOString());
      }
    }

    // 2. 补漏与终态收尾：检查上周周报
    // 若当前时间已跨过上周日 23:59:59（本地），检查上周周报是否存在，
    // 或是否是在上周结束前生成的非终态快照，若需要则重新统计
    const lastWeekMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    let lastWeekId;
    try {
      lastWeekId = store.getWeekId(new Date(lastWeekMs));
      if (!/^\d{4}-W\d{2}$/.test(lastWeekId)) throw new Error('Invalid weekId: ' + lastWeekId);
    } catch (e) {
      console.error('[weekly-report] getWeekId failed:', e.message);
      return;
    }

    // 若上周周报被用户显式删除，跳过自动补漏收尾（尊重删除意图）
    if (store.isWeeklyReportDeleted(lastWeekId)) {
      return;
    }

    const { end } = store.getWeekRange(lastWeekId);
    const offset = end.getTimezoneOffset() * 60 * 1000;
    const endOfWeekMs = end.getTime() + offset + 24 * 60 * 60 * 1000 - 1;
    const existingLastWeek = store.getWeeklyReport(lastWeekId);

    if (now.getTime() > endOfWeekMs) {
      const needsGeneration = !existingLastWeek || (new Date(existingLastWeek.generatedAt).getTime() <= endOfWeekMs);
      if (needsGeneration) {
        store.generateWeeklyReport(lastWeekId);
        broadcastDataChanged({ action: 'REPORT_CREATED', id: lastWeekId });
        console.log('[weekly-report] finalized last week report ' + lastWeekId);
      }
    }
  } catch (e) {
    console.error('[weekly-report] auto-generate failed:', e.message);
  }
}

app.on('window-all-closed', () => {
  // 跨平台:除 macOS 外,所有窗口关闭时退出应用
  if (!app.isQuitting && process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ==================== 撤销栈 (Undo) ====================
// 每次写操作前保存 data 快照到 history,最多保存 5 份
// 恢复时直接替换 data + 强制刷新 UI(非标准 undo)
const UNDO_LIMIT = 5;
let undoStack = [];   // [{data, label}, ...]

function snapshotData() {
  // Bug-内存刺客修复:不再全量深拷贝整个 store.data。
  // 任务/便签/周报/墓碑参与撤回(会变)需要深拷;config 不参与任务撤回,直接复用引用。
  // JSON.parse(JSON.stringify(...)) 比 structuredClone 在大对象上略快且兼容性更好。
  return {
    ...store.data,
    tasks: JSON.parse(JSON.stringify(store.data.tasks)),
    notes: JSON.parse(JSON.stringify(store.data.notes)),
    weeklyReports: JSON.parse(JSON.stringify(store.data.weeklyReports || [])),
    deletedWeeklyReports: JSON.parse(JSON.stringify(store.data.deletedWeeklyReports || [])),
  };
}

function pushUndo(label) {
  undoStack.push({ data: snapshotData(), label, at: new Date().toISOString() });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function clearUndo() {
  undoStack = [];
}

// ==================== IPC 入口 ====================

// //
ipcMain.handle('tasks:getAll', () => {
  return store.getAll();
});

// //
ipcMain.handle('tasks:getActive', () => {
  return store.getActive();
});

// //
ipcMain.handle('tasks:getCompleted', () => {
  return store.getCompleted();
});

// //
ipcMain.handle('tasks:create', (event, task) => {
  const clean = sanitizeTaskInput(task);
  if (!clean) return { error: '无效的任务数据' };
  pushUndo('新建任务');
  const result = store.createTask(clean);
  broadcastDataChanged({ action: 'TASK_CREATED', id: result.id, payload: result }, event.sender);
  return result;
});

// 批量创建:100 行文本只写一次磁盘
ipcMain.handle('tasks:batchCreate', (event, tasks) => {
  if (!Array.isArray(tasks)) return { error: 'tasks 必须是数组' };
  const clean = tasks.map(sanitizeTaskInput).filter(Boolean);
  if (clean.length === 0) return { error: '没有有效任务' };
  pushUndo(`批量新建 ${clean.length} 个任务`);
  const result = store.batchCreateTasks(clean);
  broadcastDataChanged({ action: 'TASKS_BATCH_CREATED', ids: result.map(t => t.id), payload: result }, event.sender);
  return result;
});

// //
ipcMain.handle('tasks:update', (event, id, updates) => {
  if (!sanitizeId(id)) return { error: '无效的任务 ID' };
  if (!isPlainObject(updates)) return { error: 'updates 必须是对象' };
  // 过滤非法字段，防止原型污染
  const clean = {};
  for (const [k, v] of Object.entries(updates)) {
    if (typeof k === 'string' && !Object.hasOwn(Object.prototype, k)) {
      clean[k] = v;
    }
  }
  pushUndo('更新任务');
  const result = store.updateTask(id, clean);
  broadcastDataChanged({ action: 'TASK_UPDATED', id, payload: clean }, event.sender);
  return result;
});

// //
ipcMain.handle('tasks:delete', (event, id) => {
  if (!sanitizeId(id)) return { error: '无效的任务 ID' };
  pushUndo('删除任务');
  const result = store.deleteTask(id);
  broadcastDataChanged({ action: 'TASK_DELETED', id, payload: result }, event.sender);
  return result;
});

// //
ipcMain.handle('tasks:complete', (event, id) => {
  if (!sanitizeId(id)) return { error: '无效的任务 ID' };
  pushUndo('完成任务');
  const result = store.completeTask(id);
  const ids = Array.isArray(result) ? result.map(t => t.id) : [id];
  broadcastDataChanged({ action: 'TASK_COMPLETED', id, payload: { ids } }, event.sender);
  return result;
});

// //

// 批量完成:仅 1 个 undo 步骤,避免弹窗疲劳
ipcMain.handle('tasks:batchComplete', (event, ids) => {
  const clean = sanitizeIdArray(ids);
  if (!clean || clean.length === 0) return [];
  pushUndo(`批量完成 ${clean.length} 个任务`);
  const all = [];
  for (const id of clean) {
    try { all.push(...store.completeTask(id)); } catch (_) {}
  }
  broadcastDataChanged({ action: 'TASKS_BATCH_COMPLETED', ids: clean, payload: { completed: all } }, event.sender);
  return all;
});

// 批量删除:仅 1 个 undo 步骤
ipcMain.handle('tasks:batchDelete', (event, ids) => {
  const clean = sanitizeIdArray(ids);
  if (!clean || clean.length === 0) return { deleted: [], promoted: [], promotedTasks: [] };
  pushUndo(`批量删除 ${clean.length} 个任务`);
  const result = { deleted: [], promoted: [], promotedTasks: [] };
  for (const id of clean) {
    try {
      const r = store.deleteTask(id);
      result.deleted.push(...r.deleted);
      result.promoted.push(...(r.promoted || []));
      if (Array.isArray(r.promotedTasks)) result.promotedTasks.push(...r.promotedTasks);
    } catch (_) {}
  }
  // 广播真实删除集合 + 升顶快照（勿只传请求 ids）
  broadcastDataChanged({
    action: 'TASKS_BATCH_DELETED',
    ids: result.deleted,
    payload: { deleted: result.deleted, promotedTasks: result.promotedTasks },
  }, event.sender);
  return result;
});

// 批量改优先级
ipcMain.handle('tasks:batchSetPriority', (event, ids, priority) => {
  const clean = sanitizeIdArray(ids);
  if (!clean || clean.length === 0) return [];
  pushUndo(`批量改优先级 ${clean.length} 个任务`);
  const result = [];
  for (const id of clean) {
    try { result.push(store.updateTask(id, { priority: priority || null })); } catch (_) {}
  }
  broadcastDataChanged({ action: 'TASKS_BATCH_PRIORITY', ids: clean, payload: { priority } }, event.sender);
  return result;
});
ipcMain.handle('tasks:uncomplete', (event, id) => {
  if (!sanitizeId(id)) return { error: '无效的任务 ID' };
  pushUndo('恢复任务');
  const result = store.uncompleteTask(id);
  broadcastDataChanged({
    action: 'TASK_UNCOMPLETED',
    id,
    payload: result ? {
      id: result.id,
      parentId: result.parentId,
      content: result.content,
      order: result.order,
      completed: false,
      completedAt: null,
      updatedAt: result.updatedAt,
    } : null,
  }, event.sender);
  return result;
});

// 批量恢复(原子操作):把一组任务一次性恢复成之前的状态,只压一条 undo 记录
ipcMain.handle('tasks:batchUncomplete', (event, ids) => {
  const clean = sanitizeIdArray(ids);
  if (!clean || clean.length === 0) return null;
  pushUndo(`批量恢复任务 ${clean.length} 个`);
  const tasks = [];
  for (const id of clean) {
    try {
      const t = store.uncompleteTask(id);
      if (t) {
        tasks.push({
          id: t.id,
          parentId: t.parentId,
          content: t.content,
          order: t.order,
          completed: false,
          completedAt: null,
          updatedAt: t.updatedAt,
        });
      }
    } catch (_) {}
  }
  broadcastDataChanged({
    action: 'TASKS_BATCH_UNCOMPLETED',
    ids: clean,
    payload: { tasks },
  }, event.sender);
  return true;
});

// 调整层级（Delta Sync:reorder 可能跨 parent，全量 reload）
ipcMain.handle('tasks:reorder', (event, items) => {
  if (!Array.isArray(items)) return { error: 'items 必须是数组' };
  const clean = items.filter(i => sanitizeId(i.id) && typeof i.order === 'number').slice(0, 10000);
  if (clean.length === 0) return { error: '没有有效数据' };
  pushUndo('调整层级');
  const result = store.reorderTasks(clean);
  broadcastDataChanged({ action: 'TASK_REORDERED', ids: items.map(i => i.id) }, event.sender);
  return result;
});

// 手动清理过期已完成任务
ipcMain.handle('tasks:cleanup', () => {
  // Bug-98 幽灵撤回修复:启动时/手动清理时如果没有任何数据被删除(removed === 0),
  // 不应压入撤回栈,否则用户打开应用就会看到"撤回: 清理旧数据"出现在菜单中,
  // 产生强烈的认知困惑。
  const snapshot = snapshotData();
  const result = store.cleanupOldCompleted();
  if (result.removed > 0) {
    // 真删了数据才压栈
    undoStack.push({ data: snapshot, label: '清理旧数据', at: new Date().toISOString() });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    broadcastDataChanged({ action: 'TASKS_CLEANED', ids: result.deleted, payload: result });
  }
  return result;
});

// 单独删除的原子操作不入 undo 历史,因为是确定性操作,无需撤销)
ipcMain.handle('reports:list', () => {
  // 页面激活触发自动生成(之前依赖 setInterval 全局路由,这里回调链中断
  tryAutoWeeklyReport();
  return store.listWeeklyReports();
});

// ====== 配置与周报操作 IPC 接口 ======
ipcMain.handle('config:get', () => store.getConfig());
// Bug-99 时空悖论修复:Config 是应用偏好(不是文档数据),不应与任务/便签混用同一个撤回栈。
// 否则用户改了保留天数后按 Ctrl+Z,设置会神秘回档。防御误操作靠前端 settings.html 的
// confirm 对话框,不靠全局 Undo。
ipcMain.handle('config:update', (event, updates) => {
  const result = store.updateConfig(updates);
  // lastView / lastDailyReminderDate 仅为内部状态，不广播
  const keys = Object.keys(updates || {});
  const skipBroadcast = keys.length > 0 && keys.every(k =>
    k === 'lastView' || k === 'lastDailyReminderDate'
  );
  if (!skipBroadcast) {
    broadcastDataChanged({ action: 'CONFIG_UPDATED', payload: updates }, event.sender);
  }
  // 提醒开关/时间变更后立刻检查（含「改到已过时刻则补响」）
  if (updates && (
    typeof updates.dailyReminderEnabled === 'boolean'
    || updates.dailyReminderHour != null
    || updates.dailyReminderMinute != null
  )) {
    try { tryDailyReminder(); } catch (_) {}
  }
  return result;
});

ipcMain.handle('reminder:getPayload', (event, opts) => {
  const mode = opts && opts.mode ? opts.mode : reminderSession.mode;
  const useScope = opts && typeof opts.useScope === 'boolean'
    ? opts.useScope
    : reminderSession.useScope;
  return buildReminderPayload({ mode, useScope });
});

ipcMain.handle('reminder:openPanel', (event, opts) => {
  openReminderWindow({
    mode: (opts && opts.mode) || 'near',
    useScope: !!(opts && opts.useScope),
  });
  return true;
});

ipcMain.handle('reminder:focusTask', (event, id) => {
  if (!sanitizeId(id)) return { ok: false };
  const hadWindow = !!(mainWindow && !mainWindow.isDestroyed());
  const win = ensureMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send('reminder:navigate-task', id);
  };
  // 主窗被关掉重建时，等加载完再导航，否则渲染进程还没挂上监听
  if (!hadWindow || win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
  return { ok: true };
});
ipcMain.handle('reports:delete', (event, weekId) => {
  pushUndo('删除周报');
  const result = store.deleteWeeklyReport(weekId);
  broadcastDataChanged({ action: 'REPORT_DELETED', id: weekId }, event.sender);
  return result;
});
ipcMain.handle('reports:update', (event, weekId, updates) => {
  pushUndo('更新周报备注');
  const result = store.updateWeeklyReport(weekId, updates);
  broadcastDataChanged({ action: 'REPORT_UPDATED', id: weekId, payload: updates }, event.sender);
  return result;
});

ipcMain.handle('reports:get', (event, weekId) => {
  return store.getWeeklyReport(weekId);
});

ipcMain.handle('reports:generate', (event, weekId) => {
  return store.generateWeeklyReport(weekId);
});

// //
ipcMain.handle('undo:list', () => {
  //  5 (), UI 已加载完成
  return undoStack.slice().reverse().map((s, i) => ({
    step: undoStack.length - i,  // 1..N
    label: s.label,
    at: s.at,
  }));
});

ipcMain.handle('undo:canUndo', () => {
  return undoStack.length > 0;
});

ipcMain.handle('undo:undo', (event) => {
  if (undoStack.length === 0) return { ok: false, message: '没有可撤回的操作' };
  const last = undoStack.pop();
  // Bug-撤回栈时空覆灭修复:周报和系统配置属于"侧效应数据",不应随业务数据一同回档。
  // 否则用户点完"生成本周周报"或改了"任务保留天数"后,撤回上一个任务改动会一并抹除。
  const currentReports = store.data.weeklyReports;
  const currentDeletedReports = store.data.deletedWeeklyReports;
  const currentConfig = store.data.config;
  const currentNotes = store.data.notes;
  const restoresAll = last.label.includes('导入');
  // 替换 data + 强制写盘
  store.data = last.data;
  // ========== 🚀 修复核心：有条件隔离 ==========
  // 如果撤回的动作不包含"周报"二字,则保护现有周报与删除墓碑不被回档覆盖；
  // 如果撤回的正是"删除周报"或"更新周报备注",则不执行覆盖,让快照里的旧周报顺利恢复。
  if (!restoresAll && !last.label.includes('周报')) {
    store.data.weeklyReports = currentReports;
    store.data.deletedWeeklyReports = currentDeletedReports;
  }
  // 系统配置保持绝对隔离（不参与任何撤回）
  store.data.config = currentConfig;
  if (!restoresAll && !/(便签|备忘录)/.test(last.label)) store.data.notes = currentNotes;
  // =============================================
  store.save();
  broadcastDataChanged({ action: 'DATA_UNDO' }, event.sender); // undo 涉及多任务跨表,全量 reload
  return {
    ok: true,
    label: last.label,
    remaining: undoStack.length,
  };
});

ipcMain.handle('undo:clear', () => {
  clearUndo();
  return { ok: true };
});

//当前 ISO 日期字符串统一用本地时区解析,避免 new Date() 时区偏移
ipcMain.handle('reports:currentWeekId', () => {
  return store.getWeekId(new Date());
});

// 剪贴板写入（渲染进程 file:// 下 navigator.clipboard 不可靠，走主进程）
ipcMain.handle('clipboard:write', (event, text) => {
  if (typeof text !== 'string') return false;
  const { clipboard } = require('electron');
  clipboard.writeText(text);
  return true;
});

// 获取上一周 weekId（"生成上周周报"按钮用）
ipcMain.handle('reports:lastWeekId', () => {
  return store.getWeekId(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
});

// //
ipcMain.handle('gantt:data', () => {
  return store.getGanttData();
});

// //
// 图片导出:仅弹窗返回路径,不携带任何重负载数据
// 审计 1.2：一次性 Token 替代全局变量 authorizedSavePath，消除竞态窗口
const ImageSaveAuthorizations = require('./image-save-authorizations');
const imageSaveAuthorizations = new ImageSaveAuthorizations();

ipcMain.handle('gantt:requestSavePath', async (event) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) || mainWindow, {
    title: '将甘特图导出为PNG',
    defaultPath: `甘特图-${getLocalDateStr()}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (!result.canceled && result.filePath) {
    const token = imageSaveAuthorizations.authorize(event.sender.id, result.filePath);
    return { filePath: result.filePath, token };
  }
  return null;
});

ipcMain.handle('gantt:writeImageBuffer', async (event, filePath, arrayBuffer, token) => {
  try {
    imageSaveAuthorizations.consume(event.sender.id, filePath, token);
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// // 导出甘特图为 Excel,Excel 可打开
ipcMain.handle('gantt:exportExcel', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '将甘特图导出为Excel',
    defaultPath: `甘特图-${getLocalDateStr()}.xlsx`,
    filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };

  const tasks = store.getGanttData();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Module';
  workbook.created = new Date();

  // ==================== Sheet1: 甘特图 ====================
  const ganttSheet = workbook.addWorksheet('甘特图', { views: [{ state: 'frozen', xSplit: 5, ySplit: 1 }] });

  // //
  // Bug-Excel-OOM 修复: 过滤剔除日期异常的任务 (2000~2050 之外), 防止 66 万列炸内存
  let minDate = null, maxDate = null;
  for (const t of tasks) {
    if (t.start) {
      const d = parseLocalDate(t.start);
      if (d && d.getFullYear() >= 2000 && d.getFullYear() <= 2050) {
        if (!minDate || d < minDate) minDate = d;
      }
    }
    if (t.end) {
      const d = parseLocalDate(t.end);
      if (d && d.getFullYear() >= 2000 && d.getFullYear() <= 2050) {
        if (!maxDate || d > maxDate) maxDate = d;
      }
    }
  }
  if (!minDate) minDate = new Date();
  if (!maxDate) { maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 30); }
  minDate = new Date(minDate); minDate.setDate(minDate.getDate() - 3);
  maxDate = new Date(maxDate); maxDate.setDate(maxDate.getDate() + 7);

  // 防御:即使数据合规,跨度也不能超过 1095 天(约 3 年),与前端 renderGantt 拦截一致
  const spanDays = Math.ceil((maxDate - minDate) / 86400000) + 1;
  const MAX_SPAN = 1095;
  if (spanDays > MAX_SPAN) {
    const half = Math.floor(MAX_SPAN / 2) * 86400000;
    const todayMs = new Date().setHours(0, 0, 0, 0);
    minDate = new Date(todayMs - half);
    maxDate = new Date(todayMs + half);
  }
  const dates = [];
  const d = new Date(minDate);
  while (d <= maxDate) {
    dates.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }

  // 每行按固定顺序写 columns(固定 getColumn 列索引避免运行时计算开销)
  const baseCols = [
    { header: '层级', key: 'level', width: 12 },
    { header: '任务名称', key: 'name', width: 35 },
    { header: '开始日期', key: 'start', width: 14 },
    { header: '截止日期', key: 'end', width: 14 },
    { header: '状态', key: 'status', width: 12 },
  ];
  for (const dt of dates) {
    baseCols.push({ header: `${dt.getMonth()+1}/${dt.getDate()}`, key: `d${dates.indexOf(dt)}`, width: 4.5 });
  }
  ganttSheet.columns = baseCols;

  // 状态和层级颜色映射
  const statusColors = {
    // Bug-Excel张冠李戴修复:getGanttData 只取活跃任务,过期实际是"已延期",不是已完成
    '已延期': { argb: 'FFC0392B' },
    '进行中': { argb: 'FFF39C12' },
    '未开始': { argb: 'FF27AE60' },
    '无截止日期': { argb: 'FF95A5A6' },
  };
  const LEVEL_LABELS = ['主任务', '一级子任务', '二级子任务', '三级子任务', '四级子任务'];
  const levelColors = {
    '主任务': { argb: 'FF3498DB' },
    '一级子任务': { argb: 'FF9B59B6' },
    '二级子任务': { argb: 'FF17A2B8' },
    '三级子任务': { argb: 'FF10B981' },
    '四级子任务': { argb: 'FFF97316' },
  };
  function getTaskLevelLabel(task) {
    const lv = typeof task.level === 'number' ? task.level : 0;
    return LEVEL_LABELS[Math.min(lv, LEVEL_LABELS.length - 1)] || ('L' + lv);
  }
  const today = new Date(); today.setHours(0,0,0,0);

  // 优化点 1:列级样式继承(O(N) 时间复杂度,仅循环 dates.length 次,约 1095 次)
  // 在任务行填充前先设置好列属性,周末灰色底色只写 XML <cols> 定义,不实例化单元格
  dates.forEach((dt, colIdx) => {
    const col = ganttSheet.getColumn(colIdx + 6);
    col.alignment = { horizontal: 'center', vertical: 'middle' };
    if (dt.getDay() === 0 || dt.getDay() === 6) {
      col.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
    }
    if (dt.toDateString() === today.toDateString()) {
      col.border = { right: { style: 'medium', color: { argb: 'FFFF5722' } } };
    }
  });

  // 表头样式
  ganttSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ganttSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
  ganttSheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
  // 基础列对齐(不依赖 dates 循环)
  const totalCols = baseCols.length + dates.length;
  for (let i = 1; i <= 5; i++) {
    ganttSheet.getColumn(i).alignment = { horizontal: 'center', vertical: 'middle' };
  }
  // 今天列标红
  dates.forEach((dt, colIdx) => {
    if (dt.toDateString() === today.toDateString()) {
      ganttSheet.getCell(1, colIdx + 6).font = { bold: true, color: { argb: 'FFFF5722' } };
    }
  });

  // 优化点 2:稀疏矩阵渲染(仅循环任务存在的有效天数,不碰空白单元格)
  // 生成任务行
  tasks.forEach((task) => {
    const level = getTaskLevelLabel(task);
    const start = task.start || '';
    const end = task.end || '';
    let status = '无截止日期';
    if (task.urgency === 'overdue') status = '已延期';
    else if (task.urgency === 'due-soon' || task.urgency === 'today') status = '即将到期';
    else if (task.urgency === 'normal') status = '正常';

    const row = ganttSheet.addRow({ level, name: task.content, start, end, status });

    const statusCell = row.getCell('status');
    if (statusColors[status]) {
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: statusColors[status] };
      statusCell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    }

    // 稀疏矩阵:只填充任务"存活"的那几天,不遍历整行
    if (start && end) {
      const startDate = parseLocalDate(start);
      const endDate = parseLocalDate(end);
      const barColor = levelColors[level] || { argb: 'FF95A5A6' };
      let curDt = new Date(startDate);
      while (curDt <= endDate) {
        if (curDt >= minDate && curDt <= maxDate) {
          const dateDiff = Math.round((curDt - minDate) / 86400000);
          // P1-6 防御：尽管有 curDt >= minDate 守卫，但浮点时间戳相减时差几毫秒就可能算出 -1
          // 强制列号 ≥ 1（基础列占 1-5）
          const cell = row.getCell(Math.max(6, dateDiff + 6));
          // 任务色块强行覆盖列底色(周末灰色)
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: barColor };
        }
        curDt.setDate(curDt.getDate() + 1);
      }
    }
  });

  // ==================== Sheet2: 项目信息 ====================
  const infoSheet = workbook.addWorksheet('项目信息');
  infoSheet.columns = [
    { header: '层级', key: 'level', width: 12 },
    { header: '任务名称', key: 'name', width: 50 },
    { header: '开始日期', key: 'start', width: 16 },
    { header: '截止日期', key: 'end', width: 16 },
    { header: '天数', key: 'days', width: 10 },
    { header: '状态', key: 'status', width: 12 },
  ];
  tasks.forEach(task => {
    const level = getTaskLevelLabel(task);
    const start = task.start || '';
    const end = task.end || '';
    const days = (start && end) ? Math.round((parseLocalDate(end) - parseLocalDate(start)) / 86400000) + 1 : '';
    let status = '无截止日期';
    // Bug-Excel 张冠李戴修复:用底层计算好的 urgency 直接映射,不再重复算日期
    if (task.urgency === 'overdue') status = '已延期';
    else if (task.urgency === 'due-soon' || task.urgency === 'today') status = '即将到期';
    else if (task.urgency === 'normal') status = '正常';
    const row = infoSheet.addRow({ level, name: task.content, start, end, days, status });
    if (statusColors[status]) {
      row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: statusColors[status] };
      row.getCell('status').font = { color: { argb: 'FFFFFFFF' }, bold: true };
    }
  });
  infoSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  infoSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
  for (let i = 1; i <= 6; i++) infoSheet.getColumn(i).alignment = { horizontal: 'center' };

  // [Bug 4] EBUSY 防御：用户用 Office 打开导出的 Excel 再点导出，会触发 EBUSY 异常
  try {
    await workbook.xlsx.writeFile(result.filePath);
    return { success: true, path: result.filePath };
  } catch (err) {
    if (err.code === 'EBUSY') {
      return { success: false, error: '该 Excel 文件正在被其他程序占用，请先关闭后再导出。' };
    }
    return { success: false, error: err.message };
  }
});

//
// 主进程:仅负责弹窗 + 写盘
// //
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('debug:dataPath', () => {
  return store.dataFile;
});

//    dialog( window.confirm  Electron 模拟的 confirm)
ipcMain.handle('dialog:confirm', async (event, options) => {
  // 防御性检查：如果主窗口已销毁，直接返回 false，避免模态框卡死
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  const { message, detail, type = 'warning' } = options || {};
  const result = await dialog.showMessageBox(mainWindow, {
    type,
    buttons: ['取消', '确定'],
    defaultId: 1,
    cancelId: 0,
    title: '确认操作',
    message: message || '确认要继续吗?',
    detail: detail || '',
    noLink: true,
  });
  return result.response === 1;  // 确定=1,取消=0
});

// 导出 JSON(通过系统 save dialog)
ipcMain.handle('data:export', async () => {
  const stamp = getLocalStamp();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出数据',
    defaultPath: `数据备份-${stamp}.json`,
    filters: [{ name: 'JSON 文件', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const snapshot = store.exportSnapshot();
  fs.writeFileSync(result.filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return { ok: true, path: result.filePath, tasks: snapshot.tasks.length };
});

// 导入 JSON - step 1: 选文件对话框
ipcMain.handle('data:readFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要导入的 JSON 文件',
    filters: [{ name: 'JSON 鏂囦欢', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const snapshot = JSON.parse(raw);
    return {
      ok: true,
      path: filePath,
      snapshot,
      taskCount: Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// JSON 导入 - step 2: 验证后写入
ipcMain.handle('data:import', (event, snapshot, mode) => {
  if (!isPlainObject(snapshot)) return { error: '无效的导入数据' };
  pushUndo('导入数据');
  const result = store.importSnapshot(snapshot, mode);
  broadcastDataChanged({ action: 'DATA_IMPORTED' }, event.sender); // 导入替换全量数据，必须全量 reload
  return result;
});

// ==================== IPC ====================
ipcMain.handle('notes:list', () => {
  return store.getNotes();
});

ipcMain.handle('notes:create', (event, input) => {
  try {
    if (!isPlainObject(input)) return { error: '无效的便签数据' };
    // 颜色支持两种形式:命名 token (default/yellow/green/pink/blue) 或 #RRGGBB
    const allowedColorTokens = ['default', 'yellow', 'green', 'pink', 'blue'];
    const rawColor = isString(input.color) ? input.color : '';
    const safeColor = allowedColorTokens.includes(rawColor)
      ? rawColor
      : (rawColor.match(/^#[0-9a-fA-F]{6}$/) ? rawColor : '');
    const result = store.createNote({
      content: (typeof input.content === 'string') ? input.content.slice(0, 10000) : '',
      pinned: !!input.pinned,
      color: safeColor,
    });
    broadcastDataChanged({ action: 'NOTE_CREATED', id: result.id }, event.sender);
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('notes:update', (event, id, updates) => {
  if (!sanitizeId(id)) return { error: '无效的便签 ID' };
  const result = store.updateNote(id, updates);
  broadcastDataChanged({ action: 'NOTE_UPDATED', id, payload: updates }, event.sender);
  return result;
});

ipcMain.handle('notes:delete', (event, id) => {
  if (!sanitizeId(id)) return { error: '无效的便签 ID' };
  const result = store.deleteNote(id);
  broadcastDataChanged({ action: 'NOTE_DELETED', id }, event.sender);
  return result;
});

// 笔记排序 IPC（Delta Sync:reorder 已知 id 列表，增量 reload）
ipcMain.handle('notes:reorder', (event, items) => {
  if (!Array.isArray(items)) return { error: 'items 必须是数组' };
  const clean = items.filter(i => sanitizeId(i.id) && typeof i.order === 'number').slice(0, 10000);
  if (clean.length === 0) return { error: '没有有效数据' };
  const result = store.reorderNotes(clean);
  broadcastDataChanged({ action: 'NOTES_REORDERED', ids: clean.map(i => i.id) }, event.sender);
  return result;
});

// ==================== 双向同步刷新 ====================
// 任何写操作 -> 通知另一窗口刷新
// Delta Sync: patch = { action: string, id?: string, payload?: object }
// action 类型: TASK_COMPLETED / TASK_DELETED / TASK_CREATED / TASK_UPDATED / NOTE_CREATED ...
// 渲染进程收到后可在本地增量更新，无需 loadTasks() 全量拉取

// 广播数据变更。exceptSender = 发起写操作的 webContents：跳过它，避免回声二次渲染。
// 发起方必须自己 await 后本地 load+render；对端（另一窗）靠本广播同步。
// 系统路径（自动周报、启动清理）不传 exceptSender，通知所有窗口。
function broadcastDataChanged(patch, exceptSender = null) {
  const normalizedPatch = patch?.action?.startsWith('TASK') ? { ...patch, reloadTasks: true } : patch;
  const payload = { source: 'peer', patch: normalizedPatch || null };
  if (widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.webContents !== exceptSender) {
    widgetWindow.webContents.send('data-changed', payload);
  }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents !== exceptSender) {
    mainWindow.webContents.send('data-changed', payload);
  }
}
let widgetWindow = null;
const widgetStateFile = path.join(app.getPath('userData'), 'widget-state.json');

function getWidgetState() {
  try {
    if (fs.existsSync(widgetStateFile)) {
      return JSON.parse(fs.readFileSync(widgetStateFile, 'utf8'));
    }
  } catch (e) {}
  return { isPinned: true, width: 340, height: 520 };
}

let _isSavingWidgetState = false;
let _pendingWidgetState = null;

// 将原来的同步函数改为异步，并加入队列锁防止并发写入冲突
async function saveWidgetState(updates) {
  const state = { ...getWidgetState(), ...updates };

  // 如果当前正在写入，把最新的状态存入 pending，等当前写完再补一次
  if (_isSavingWidgetState) {
    _pendingWidgetState = state;
    return;
  }

  _isSavingWidgetState = true;
  try {
    // 改用异步 API，彻底释放主线程
    await fs.promises.writeFile(widgetStateFile, JSON.stringify(state), 'utf8');
  } catch (e) {
    console.error('[Widget State] Save failed:', e.message);
  } finally {
    _isSavingWidgetState = false;
    // 如果写入期间又有新拖拽产生的新状态，立刻补写一次
    if (_pendingWidgetState) {
      const nextState = _pendingWidgetState;
      _pendingWidgetState = null;
      saveWidgetState(nextState);
    }
  }
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.focus();
    return;
  }
  // Bug-组件失忆修复:读取上次关闭时的位置、尺寸、置顶状态,否则每次重启都回到默认
  const wState = getWidgetState();
  // Bug-多显示器越界修复:拔掉副屏后,x/y 可能跑出当前所有屏幕范围,导致窗口彻底看不见
  let safeX = wState.x;
  let safeY = wState.y;
  if (safeX !== undefined && safeY !== undefined) {
    const displays = screen.getAllDisplays();
    const isVisible = displays.some(display => {
      const b = display.bounds;
      return safeX >= b.x && safeY >= b.y && safeX < b.x + b.width && safeY < b.y + b.height;
    });
    if (!isVisible) { safeX = undefined; safeY = undefined; }
  }

  // Bug-DPI缩放累积修复 v3 (根治版):
  // v1/v2 用 getBounds()+除法 手工转换物理↔逻辑像素,存在舍入累积误差(moved/resize每触
  // 发一次就除一次 scaleFactor,非整数 DPI 如125%/175%时除法不稳定)。
  // v3 根治:getSize()/getPosition() 直接返回逻辑像素,Eletron 内部已完成转换,零除法/零误差。
  const DEFAULT_WIDTH = 340;
  const DEFAULT_HEIGHT = 520;
  let restoreWidth = wState.width || DEFAULT_WIDTH;
  let restoreHeight = wState.height || DEFAULT_HEIGHT;
  // 兼容 v1/v2 残留的物理像素老数据:明显大于默认值→除以 scaleFactor 修正
  if (restoreWidth > DEFAULT_WIDTH * 1.3 || restoreHeight > DEFAULT_HEIGHT * 1.3) {
    let displayForRestore = screen.getPrimaryDisplay();
    if (safeX !== undefined && safeY !== undefined) {
      displayForRestore = screen.getDisplayNearestPoint({ x: safeX, y: safeY });
    }
    const scaleFactor = displayForRestore.scaleFactor;
    if (scaleFactor > 1) {
      restoreWidth = Math.round(restoreWidth / scaleFactor);
      restoreHeight = Math.round(restoreHeight / scaleFactor);
    }
  }
  // 下限保护:防止异常小值(如之前除法累积缩小导致的)回退到默认尺寸
  if (restoreWidth < DEFAULT_WIDTH * 0.5) restoreWidth = DEFAULT_WIDTH;
  if (restoreHeight < DEFAULT_HEIGHT * 0.5) restoreHeight = DEFAULT_HEIGHT;

  widgetWindow = new BrowserWindow({
    width: restoreWidth,
    height: restoreHeight,
    x: safeX,
    y: safeY,
    minWidth: 280,
    minHeight: 400,
    title: '便利贴组件',
    frame: false,
    alwaysOnTop: wState.isPinned !== false,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#1a1d21',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  widgetWindow.loadFile(path.join(__dirname, '../renderer/widget.html'));

  // 拖拽已恢复为 -webkit-app-region: drag（widget.html）,不需要底层 Hook 了
  // 原生方式自动支持 DPI 缩放、多显示器、不同缩放率,比底层 WM_NCHITTEST 更稳定

  // Bug-组件失忆修复 v2:意外退出(on('close')来不及触发)也能保存位置
  let saveBoundsTimer = null;
  const debouncedSaveBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        // v3 根治:getSize()/getPosition()直接返回逻辑像素,无需除以scaleFactor
        const [w, h] = widgetWindow.getSize();
        const [x, y] = widgetWindow.getPosition();
        saveWidgetState({ x, y, width: w, height: h });
      }
    }, 500);
  };
  widgetWindow.on('moved', debouncedSaveBounds);
  widgetWindow.on('resize', debouncedSaveBounds);

  widgetWindow.on('close', () => {
    clearTimeout(saveBoundsTimer);
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      // v3 根治:getSize()/getPosition()直接返回逻辑像素
      const [w, h] = widgetWindow.getSize();
      const [x, y] = widgetWindow.getPosition();
      saveWidgetState({ x, y, width: w, height: h });
    }
    widgetWindow = null;
  });
}

ipcMain.handle('widget:toggle', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
    return { open: false };
  } else {
    createWidgetWindow();
    return { open: true };
  }
});

ipcMain.handle('widget:status', () => {
  return { open: widgetWindow && !widgetWindow.isDestroyed() };
});


// 聚焦主窗口
ipcMain.handle('widget:focusMain', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
  return { ok: true };
});

// 动态设置组件置顶状态
ipcMain.handle('widget:setAlwaysOnTop', (event, isPinned) => {
  saveWidgetState({ isPinned });
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setAlwaysOnTop(isPinned);
    return { ok: true, isPinned };
  }
  return { ok: false };
});

// 供前端启动时查询记忆的置顶状态
ipcMain.handle('widget:getPinned', () => {
  return getWidgetState().isPinned !== false;
});
