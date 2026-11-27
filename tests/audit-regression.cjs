'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');

test('all first-party JS and HTML inline scripts parse', () => {
  let checked = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (entry.name.endsWith('.min.js')) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (entry.name.endsWith('.js')) {
        const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${file}: ${result.stderr}`);
        checked++;
      } else if (entry.name.endsWith('.html')) {
        for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
          if (/\bsrc\s*=/.test(match[1]) || !match[2].trim()) continue;
          assert.doesNotThrow(() => new vm.Script(match[2], { filename: file }));
          checked++;
        }
      }
    }
  }
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'mcp-server'));
  assert(checked > 30);
});

test('Electron asynchronous save preserves report deletion markers across restart', async () => {
  const DataStore = require(path.join(ROOT, 'src/main/data-store.js'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'module-audit-'));
  const file = path.join(temp, 'tasks.json');
  const store = new DataStore(file);
  let loaded;
  try {
    store.data.weeklyReports = [{ weekId: '2026-W46' }];
    store.deleteWeeklyReport('2026-W46');
    clearTimeout(store._saveTimeout);
    store._saveTimeout = null;
    await store._saveAsync();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).deletedWeeklyReports, ['2026-W46']);
    loaded = new DataStore(file);
    loaded.load();
    assert.equal(loaded.isWeeklyReportDeleted('2026-W46'), true);
  } finally {
    clearTimeout(store._saveTimeout);
    if (loaded) clearTimeout(loaded._saveTimeout);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Tauri peer task notifications reload cascades and auto-planned ancestors', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  const events = [];
  let listener;
  const sandbox = {
    _api: { onDataChange: callback => { listener = callback; } },
    CoreServices: {
      refreshUndoUI: async () => events.push('undo'),
      loadTasks: async () => events.push('tasks'),
      loadNotes: async () => events.push('notes'),
      refreshConfig: async () => events.push('config'),
    },
    safeRender: async () => events.push('render'),
    applyPeerDelta: () => { throw Error('Partial delta must not apply to Tauri task writes'); },
  };
  vm.runInNewContext(source.slice(source.indexOf('_api.onDataChange(async (data) => {')), sandbox);
  for (const action of ['TASK_CREATED', 'TASKS_BATCH_COMPLETED', 'TASKS_BATCH_DELETED', 'TASK_UPDATED', 'TASKS_CLEANED']) {
    events.length = 0;
    await listener({ patch: { action, reloadTasks: true, id: 'parent' } });
    assert.deepEqual(events, ['undo', 'tasks', 'render'], action);
  }
  events.length=0;
  await listener({patch:{action:'DATA_IMPORTED'}});
  assert.deepEqual(events,['undo','config','tasks','notes','render']);
  events.length=0;
  await listener({patch:{action:'EXTERNAL_DATA_CHANGED'}});
  assert.deepEqual(events,['undo','config','tasks','notes','render']);
});

test('Tauri bridge forwards replace imports, task batches and undo results', async () => {
  const calls = [];
  const window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push({ command, args }); return { ok: true, label: '删除周报', remaining: 2 }; } },
    event: { listen: async () => () => {} },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/renderer/api-bridge.js'), 'utf8'), { window });
  await window.api.data.import({ tasks: [] }, 'replace');
  assert.equal(calls[0].command, 'data_import');
  assert.equal(calls[0].args.mode, 'replace');
  await window.api.tasks.batchComplete(['parent']);
  assert.equal(calls[1].command, 'tasks_batch_complete');
  assert.equal((await window.api.undo.undo()).remaining, 2);
  await window.api.gantt.exportExcel(['p1']);
  assert.equal(calls[3].command, 'gantt_export_excel');
  assert.deepEqual(calls[3].args.projectScopeIds, ['p1']);
  await window.api.gantt.exportCsv(['p1']);
  assert.equal(calls[4].command, 'gantt_export_csv');
  await window.api.backups.list();
  assert.equal(calls[5].command, 'backups_list');
  await window.api.backups.restore('daily-2026-11-25_010203000-0001-abcdef.json');
  assert.equal(calls[6].command, 'backups_restore');
});

test('GanttView discards stale resolves/rejections across navigation and concurrent renders while keeping fallback container', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/views/gantt.js'), 'utf8');
  const fallback = { innerHTML: '' };
  const resolvers = [];
  const rejectors = [];
  const state = { view: 'gantt', tasks: [], collapsed: new Set(), projectScopeIds: [] };
  const sandbox = {
    window: {
      api: { gantt: { data: () => new Promise((res, rej) => { resolvers.push(res); rejectors.push(rej); }) } },
      ModuleApp: { State: { state } },
    },
    document: {
      getElementById: id => (id === 'viewContainer' ? fallback : null),
      querySelectorAll: () => [],
      removeEventListener: () => {},
    },
    localStorage: { getItem: () => '0' },
    console: { error() {}, log() {} },
  };
  vm.runInNewContext(source, sandbox);
  const view = sandbox.window.ModuleApp.GanttView;

  // 1. Without calling mount(), render falls back to #viewContainer and blocks out-of-order stale response/error.
  const req1 = view.render();
  const req2 = view.render();
  resolvers[1]([]); // req2 is latest and renders empty-state via fallback #viewContainer
  await req2;
  const req2Html = fallback.innerHTML;
  assert(req2Html.includes('没有可显示的任务'));
  rejectors[0](new Error('late error from req1')); // stale error must not overwrite
  await req1;
  assert.equal(fallback.innerHTML, req2Html);

  // 2. Navigating away (unmount + view='notes') discards pending req3 success & error.
  const req3 = view.render();
  const req4 = view.render();
  view.unmount();
  state.view = 'notes';
  fallback.innerHTML = '<textarea>NOTES_DRAFT</textarea>';
  resolvers[2]([]);
  rejectors[3](new Error('late error after unmount'));
  await Promise.all([req3, req4]);
  assert.equal(fallback.innerHTML, '<textarea>NOTES_DRAFT</textarea>');
});

test('startup cleanup refreshes the initiating window after a successful deletion', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  const code = source.match(/async function cleanupAndRefresh\(\) \{[\s\S]*?\n\}/)[0];
  const events = [];
  const sandbox = {
    _api: { tasks: { cleanup: async () => { events.push('cleanup'); return {removed: 2}; } } },
    CoreServices: { loadTasks: async () => events.push('load'), refreshUndoUI: async () => events.push('undo') },
    safeRender: async () => events.push('render'),
    showDataError: e => { throw e; },
  };
  vm.runInNewContext(code + '\nglobalThis.cleanup = cleanupAndRefresh;', sandbox);
  await sandbox.cleanup();
  assert.deepEqual(events, ['cleanup', 'load', 'render', 'undo']);
});

test('legacy report timestamps use local days, while calendar-only dates remain literal', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/views/reports.js'), 'utf8');
  const format = source.match(/function _fmtDate\(iso\) \{[\s\S]*?\n  \}/)[0];
  for (const [tz, iso, expected] of [
    ['Asia/Shanghai', '2026-11-08T16:00:00Z', '2026年11月09日'],
    ['America/Los_Angeles', '2026-11-16T07:59:59Z', '2026年11月15日'],
    ['America/Los_Angeles', '2026-11-09', '2026年11月09日'],
  ]) {
    const result = spawnSync(process.execPath, [], {
      input: `const _locale = () => 'zh-CN'; const format = (${format}); process.stdout.write(format(${JSON.stringify(iso)}));`,
      encoding: 'utf8', env: {...process.env, TZ: tz},
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, tz);
  }
});

test('safeRender drains updates arriving during both the first and second asynchronous render', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  const code = source.slice(source.indexOf('let _isRendering'), source.indexOf('function patchRender'));
  const pending = [];
  let calls = 0;
  const sandbox = {
    CoreServices: {render: () => { calls++; return new Promise(resolve => pending.push(resolve)); }},
    showDataError: e => { throw e; },
  };
  vm.runInNewContext(code + '\nglobalThis.render = safeRender;', sandbox);
  const rendering = sandbox.render();
  await sandbox.render();
  pending[0]();
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  await sandbox.render();
  pending[1]();
  await new Promise(setImmediate);
  assert.equal(calls, 3);
  pending[2]();
  await rendering;
});

test('CoreServices returns the asynchronous report render so its caller can await it', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  const start = source.indexOf('const CoreServices = {');
  const end = source.indexOf('\n};', start) + 3;
  let release;
  const nodes = new Map();
  const state = {view: 'reports', tasks: [], multiSelect: new Set()};
  const sandbox = {
    window: {ModuleApp: {
      State: {state}, ReportsView: {render: () => new Promise(resolve => { release = resolve; })},
      TaskController: {updateQuickInputHint() {}}, SearchController: {updateSearchResult() {}},
    }},
    document: {activeElement: null, querySelector: () => null, getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id);
    }},
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.core = CoreServices;', sandbox);
  let settled = false;
  const promise = sandbox.core.render().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await promise;
  assert.equal(settled, true);
});

test('startup read failures show a recovery message instead of silently presenting an empty database', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  const code = source.match(/function startApp\(\) \{[\s\S]*?\n\}/)[0];
  let message;
  const sandbox = {
    init: async () => { throw Error('damaged tasks-data.json'); },
    showDataError: () => {},
    tr: (_k, fb, p) => (fb || _k).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] !== undefined ? String(p[k]) : m)),
    document: { getElementById: () => ({replaceChildren: node => { message = node; }}),
      createElement: () => ({setAttribute: () => {}}) },
  };
  vm.runInNewContext(code + '\nstartApp();', sandbox);
  await new Promise(setImmediate);
  assert(message.textContent.includes('原文件已保留'));
  assert(message.textContent.includes('damaged tasks-data.json'));
});

function loadCore(sandbox) {
  const source=fs.readFileSync(path.join(ROOT,'src/renderer/app.js'),'utf8');
  const start=source.indexOf('const CoreServices = {'),end=source.indexOf('\n};',start)+3;
  const env={tr:(_k,fb,p)=>(fb||_k).replace(/\{(\w+)\}/g,(m,k)=>(p&&p[k]!==undefined?String(p[k]):m)),...sandbox};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.core=CoreServices;',env);
  return env.core;
}

test('undo rejects are reported, duplicate requests are ignored and controls recover', async () => {
  const button={disabled:false};
  const errors=[];
  let reject,requests=0,refreshed=0;
  const core=loadCore({
    _api:{undo:{undo:()=>{requests++;return new Promise((_r,j)=>{reject=j;});}}},
    document:{getElementById:()=>button},
    window:{ModuleApp:{Toast:{show:()=>{}}}},
    showDataError:error=>errors.push(String(error)),
  });
  core.refreshUndoUI=async()=>{refreshed++;button.disabled=false;};
  const first=core.performUndo();
  await core.performUndo();
  assert.equal(requests,1);
  reject('revision conflict');
  await assert.doesNotReject(first);
  assert(errors[0].includes('revision conflict'));
  assert.equal(core._undoPending,false);
  assert.equal(button.disabled,false);
  assert.equal(refreshed,1);
});

test('configuration reload aligns imported auto-plan, scope and theme with backend values', async () => {
  const state={autoPlan:false,projectScopeIds:[]};
  const toggles=[];
  const themeButton={textContent:''};
  const sandbox={
    _api:{config:{get:async()=>({autoPlan:true,projectScopeIds:['imported'],theme:'dark'})}},
    window:{ModuleApp:{State:{patch:patch=>Object.assign(state,patch)}}},
    document:{body:{classList:{toggle:(...args)=>toggles.push(args)}}, getElementById:id=>id==='themeToggleBtn'?themeButton:{classList:{toggle:(...args)=>toggles.push(args)}}},
    localStorage:{setItem:()=>{}},
  };
  const core=loadCore(sandbox);
  core.refreshProjectScopeSelect=()=>{}; core.updateAddTaskBtnLabel=()=>{};
  await core.refreshConfig();
  assert.equal(state.autoPlan,true);
  assert.deepEqual(state.projectScopeIds,['imported']);
  assert(toggles.some(([name,on])=>name==='theme-dark' && on));
  assert.equal(themeButton.textContent,'☀️ 浅色');
});
