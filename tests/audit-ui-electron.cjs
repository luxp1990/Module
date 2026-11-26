'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
app.disableHardwareAcceleration();
app.setPath('userData', process.argv[2]);
let win;
async function run(code) { return win.webContents.executeJavaScript(code, true); }
async function loadScript(rel) { await run(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('Renderer:', message); });
  await win.loadURL('data:text/html;charset=utf-8,<html><body><div id="root"></div><textarea id="quickInput"></textarea></body></html>');
  await run(`window.testToasts = []; window.ModuleApp = {
    Toast: {show: (...args) => testToasts.push(args)},
    State: {state: {notes: []}, patch: patch => Object.assign(ModuleApp.State.state, patch)},
    refreshUndoUI: async () => {}
  }; window.api = {};`);
  await loadScript('src/renderer/views/notes.js');
  const notes = await run(`(async () => {
    const state = ModuleApp.State.state;
    state.view = 'notes';
    state.notes = [{id:'n1', content:'stored', color:'default'}];
    const view = ModuleApp.NotesView;
    view.mount(document.getElementById('root'));
    view.render(state, 'REPLACE');
    let input = document.getElementById('noteNewInput');
    input.value = '未保存的新草稿'; input.focus(); input.setSelectionRange(2, 5);
    view.render(state, 'REPLACE');
    input = document.getElementById('noteNewInput');
    const focusedDraft = input.value === '未保存的新草稿' && document.activeElement === input && input.selectionStart === 2 && input.selectionEnd === 5;
    input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
    view.render(state, 'REPLACE');
    const composingSafe = document.getElementById('noteNewInput') === input;
    input.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true}));
    input = document.getElementById('noteNewInput');
    input.blur();
    await view._startEdit('n1');
    let edit = document.getElementById('noteEdit_n1');
    edit.value = '尚未保存的编辑'; edit.focus(); edit.setSelectionRange(1, 3);
    state.notes[0].content = 'peer saved content';
    view.render(state, 'REPLACE');
    edit = document.getElementById('noteEdit_n1');
    const focusedEdit = edit.value === '尚未保存的编辑' && document.activeElement === edit && edit.selectionStart === 1;
    const newDraftStillThere = document.getElementById('noteNewInput').value === '未保存的新草稿';
    edit.blur();
    view.render(state, 'REPLACE');
    const blurredEdit = document.getElementById('noteEdit_n1').value === '尚未保存的编辑';
    api.notes = {update:async () => {throw new Error('disk full')}};
    await view._saveEdit('n1');
    const failedSaveKeepsDraft = document.getElementById('noteEdit_n1').value === '尚未保存的编辑';
    state.notes = [];
    view.render(state, 'REPLACE');
    const rescue = document.getElementById('noteNewInput').value.includes('尚未保存的编辑');
    return {focusedDraft, composingSafe, focusedEdit, newDraftStillThere, blurredEdit, failedSaveKeepsDraft, rescue};
  })()`);
  for (const [name, passed] of Object.entries(notes)) assert(passed, `notes ${name}`);
  console.log('PASS UI: focused/blurred note drafts, caret, peer updates and deleted-note rescue');

  const failedEditSwitch = await run(`(async () => {
    const view = ModuleApp.NotesView;
    const state = ModuleApp.State.state;
    state.notes = [{id:'n1',content:'one',color:'default'},{id:'n2',content:'two',color:'default'}];
    view._editingId = null; view._editDraft = null; view._newDraft = '';
    document.getElementById('root').innerHTML = '';
    view.render(state, 'REPLACE');
    await view._startEdit('n1');
    document.getElementById('noteEdit_n1').value = 'must keep unsaved n1';
    let rejectSave;
    api.notes = {update: () => new Promise((_resolve,reject) => {rejectSave=reject;})};
    const saving = view._saveEdit('n1');
    const switching = view._startEdit('n2');
    rejectSave(new Error('write conflict'));
    await saving; await switching;
    view.render(state, 'REPLACE'); // A later peer refresh must not discard an abandoned failed edit.
    return !!document.getElementById('noteEdit_n1')?.value.includes('must keep unsaved n1')
      || document.getElementById('noteNewInput').value.includes('must keep unsaved n1');
  })()`);
  assert(failedEditSwitch, 'failed save followed by switching notes must preserve the first draft');
  console.log('PASS UI: switching notes while a save fails preserves the first draft');

  const pendingEdit = await run(`(async () => {
    const view = ModuleApp.NotesView, state = ModuleApp.State.state;
    const root = document.getElementById('root');
    let resolveSave;
    api.notes = {update: () => new Promise(resolve => {resolveSave=resolve;}), list:async () => state.notes};
    const saving = view._saveEdit('n1');
    document.getElementById('noteEdit_n1').value = 'additional input while saving';
    resolveSave(); await saving;
    const newTextPreserved = document.getElementById('noteEdit_n1').value === 'additional input while saving';
    const nextSave = view._saveEdit('n1');
    view.captureDrafts(); state.view = 'reports'; root.textContent = 'OTHER VIEW';
    resolveSave(); await nextSave;
    const navigationSafe = root.textContent === 'OTHER VIEW';
    return {newTextPreserved,navigationSafe};
  })()`);
  for (const [name, passed] of Object.entries(pendingEdit)) assert(passed, `pending edit ${name}`);
  console.log('PASS UI: pending note save preserves new typing and cannot overwrite another view');

  const hiddenDraft = await run(`(async () => {
    const view=ModuleApp.NotesView,state=ModuleApp.State.state;
    state.view='notes'; state.notesFilter='all';
    view.render(state,'REPLACE');
    await view._startEdit('n1');
    document.getElementById('noteEdit_n1').value='hidden edit must survive';
    view.captureDrafts();
    state.notes.find(n=>n.id==='n2').pinned=true;
    state.notesFilter='pinned'; view.render(state,'REPLACE');
    api.notes.update=async()=>{throw new Error('save rejected');};
    await view._startEdit('n2');
    state.notesFilter='all'; view.render(state,'REPLACE');
    return document.getElementById('noteEdit_n1')?.value === 'hidden edit must survive';
  })()`);
  assert(hiddenDraft,'a filtered-out editor must save from its draft or retain it on failure');
  console.log('PASS UI: filtered-out note drafts survive failed saves and editor switching');

  await loadScript('src/renderer/views/reports.js');
  const reports = await run(`(async () => {
    const root = document.getElementById('root');
    const view = ModuleApp.ReportsView;
    view.mount(root);
    const pending = [];
    api.reports = {list: () => new Promise(resolve => pending.push(resolve))};
    const state = {view:'reports'};
    const report = notes => ({weekId:'2026-W46',startDate:'2026-11-08T16:00:00Z',endDate:'2026-11-15T15:59:59Z',count:0,entries:[],notes});
    const first = view.render(state), second = view.render(state);
    pending[1]([report('new result')]); await second;
    pending[0]([report('old result')]); await first;
    const latestWins = root.textContent.includes('new result') && !root.textContent.includes('old result');
    const waiting = view.render(state);
    state.view = 'hierarchy'; view.cancelRender(); root.textContent = 'OTHER VIEW';
    pending[2]([report('late result')]); await waiting;
    const navigationSafe = root.textContent === 'OTHER VIEW';
    state.view = 'reports';
    const editingRequest = view.render(state);
    root.innerHTML = '<textarea id="reportNotesInput_2026-W46">draft</textarea>';
    document.getElementById('reportNotesInput_2026-W46').focus();
    pending[3]([report('server')]); await editingRequest;
    const editingSafe = document.activeElement.value === 'draft';
    return {latestWins, navigationSafe, editingSafe};
  })()`);
  for (const [name, passed] of Object.entries(reports)) assert(passed, `reports ${name}`);
  console.log('PASS UI: report response ordering, navigation and edits started during request');

  await loadScript('src/renderer/controllers/task-controller.js');
  const batch = await run(String.raw`(async () => {
    const controller = ModuleApp.TaskController;
    controller._state = {state:{selectedId:null,tasks:[],quickDraft:{}}};
    api.tasks = {batchCreate: async () => {throw new Error('conflict')}};
    const input = document.getElementById('quickInput');
    input.value = 'one\ntwo'; testToasts.length = 0;
    await controller.handleQuickInput();
    const failureRetainsInput = input.value === 'one\ntwo';
    const errorVisible = testToasts.some(args => args[0].includes('conflict') && args[1] === 'error');
    api.tasks.batchCreate = async tasks => tasks;
    controller._deps = {loadTasks:async()=>{}, render:()=>{}, refreshUndoUI:async()=>{}};
    controller.applyAutoPlan = async () => {};
    await controller.handleQuickInput();
    return {failureRetainsInput,errorVisible,successClearsInput:input.value === ''};
  })().catch(error => ({error: error.stack}))`);
  if (batch.error) throw Error(batch.error);
  for (const [name, passed] of Object.entries(batch)) assert(passed, `batch ${name}`);
  console.log('PASS UI: failed batch retains text and shows error; successful batch clears it');

  const widgetWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  win.destroy();
  const widgetHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/widget.html'), 'utf8');
  const helperCode = ['src/renderer/utils.js', 'src/renderer/shared/task-sort.js', 'src/renderer/shared/project-scope.js']
    .map(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
  const widgetUrlHtml = widgetHtml
    .replace('<script src="api-bridge.js"></script>', `<script>
      window.__wTasks = [{ id: 'wt1', content: '任务1', parentId: null, order: 0, startDate: '2026-11-20', deadline: '2026-11-26', completed: false }];
      window.__wNotes = [{ id: 'wn1', content: '初始便签', color: 'default', pinned: false, order: 0, createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z' }];
      window.__failNoteUpdate = false;
      window.api = {
        tasks: {
          getActive: async () => JSON.parse(JSON.stringify(window.__wTasks)),
          update: async (id, u) => { const t = window.__wTasks.find(x => x.id === id); if (!t) throw Error('Task not found'); Object.assign(t, u); return t; },
          complete: async (id) => [],
          create: async (t) => t,
        },
        notes: {
          list: async () => JSON.parse(JSON.stringify(window.__wNotes)),
          update: async (id, u) => {
            if (window.__failNoteUpdate) { const p = new Promise((_, rej) => { window.__rejectNoteSave = rej; }); return p; }
            const n = window.__wNotes.find(x => x.id === id);
            if (!n) throw Error('Note not found');
            Object.assign(n, u); return n;
          },
          create: async (inp) => { const n = { id: 'wn-new', content: inp.content, color: 'default', pinned: false, createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z' }; window.__wNotes.push(n); return n; },
          delete: async () => true, reorder: async () => true,
        },
        config: { get: async () => ({ theme: 'dark', widgetProjectScopeIds: [] }), update: async () => ({}) },
        undo: { undo: async () => ({ ok: false }) },
        widget: { getPinned: async () => true, setAlwaysOnTop: async () => ({ ok: true }), toggle: async () => ({}), focusMain: async () => ({}) },
        onDataChange: (cb) => { window.__wDataChange = cb; },
      };
    </script>`)
    .replace('<script src="utils.js"></script>', `<script>${helperCode}</script>`)
    .replace('<script src="shared/task-sort.js"></script>', '')
    .replace('<script src="shared/project-scope.js"></script>', '');
  const widgetTmp = path.join(process.argv[2], 'audit-widget.html');
  fs.writeFileSync(widgetTmp, widgetUrlHtml, 'utf8');
  await widgetWin.loadFile(widgetTmp);
  await widgetWin.webContents.executeJavaScript('new Promise(r => setTimeout(r, 120))', true);
  const widgetAudit = await widgetWin.webContents.executeJavaScript(`(async () => {
    // 0. Task editing async timing: refresh delay, IME during in-flight refresh, typing during pending save & failure retention.
    document.querySelector('.task-item[data-task-id="wt1"]').click();
    await new Promise(r => setTimeout(r, 60));
    let notesEl = document.getElementById('editNotes_wt1');
    notesEl.focus();
    notesEl.value = 'BEFORE_REFRESH';
    const origGetActive = api.tasks.getActive;
    let resolveDelayedRead;
    let delayOnce = true;
    api.tasks.getActive = () => {
      if (delayOnce) {
        delayOnce = false;
        return new Promise(resolve => { resolveDelayedRead = resolve; });
      }
      return origGetActive();
    };
    const pRefresh = refresh();
    notesEl.value = 'TYPED_WHILE_REFRESH_WAITED';
    notesEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
    resolveDelayedRead(JSON.parse(JSON.stringify(window.__wTasks)));
    await pRefresh;
    const taskTypingDuringRefresh = document.getElementById('editNotes_wt1')?.value === 'TYPED_WHILE_REFRESH_WAITED';

    notesEl = document.getElementById('editNotes_wt1');
    notesEl.focus();
    delayOnce = true;
    const pCompRefresh = refresh();
    notesEl.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    notesEl.value = '合成中的任务备注';
    resolveDelayedRead(JSON.parse(JSON.stringify(window.__wTasks)));
    await pCompRefresh;
    const taskImeSameDom = document.getElementById('editNotes_wt1') === notesEl;
    notesEl.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    const taskImeValueAfterComp = document.getElementById('editNotes_wt1')?.value === '合成中的任务备注';
    api.tasks.getActive = origGetActive;

    const origTaskUpdate = api.tasks.update;
    let resolveTaskSave;
    api.tasks.update = (id, u) => new Promise(resolve => {
      resolveTaskSave = async () => resolve(await origTaskUpdate(id, u));
    });
    notesEl = document.getElementById('editNotes_wt1');
    notesEl.value = 'SENT_TASK_NOTES';
    notesEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const pTaskSave = saveTaskEdit('wt1');
    notesEl.value = 'TYPED_AFTER_SAVE';
    notesEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await resolveTaskSave();
    await pTaskSave;
    await refresh();
    const taskTypingDuringSave = editingTaskId === 'wt1' && document.getElementById('editNotes_wt1')?.value === 'TYPED_AFTER_SAVE';

    let rejectTaskSave;
    api.tasks.update = () => new Promise((_, rej) => { rejectTaskSave = rej; });
    const pTaskFail = saveTaskEdit('wt1');
    document.getElementById('editNotes_wt1').value = 'TASK_FAIL_KEEP';
    document.getElementById('editNotes_wt1').dispatchEvent(new InputEvent('input', { bubbles: true }));
    rejectTaskSave(new Error('task save error'));
    await pTaskFail;
    const taskKeptOnFail = editingTaskId === 'wt1' && document.getElementById('editNotes_wt1')?.value === 'TASK_FAIL_KEEP';
    api.tasks.update = origTaskUpdate;
    editingTaskId = null; editingTaskOriginal = null; editingTaskDraft = null;
    await refresh();

    const qi = document.getElementById('quickInput');
    document.getElementById('tabNotes').click();
    await new Promise(r => setTimeout(r, 60));
    qi.value = '正在输入的快速便签';
    document.querySelector('.note-item[data-note-id="wn1"]').click();
    await new Promise(r => setTimeout(r, 60));
    let editEl = document.getElementById('noteEdit_wn1');
    editEl.focus();
    editEl.innerText = '草稿第一段';

    // 1. Pending save rejects while user keeps typing -> session & new typing preserved.
    window.__failNoteUpdate = true;
    const pSave = saveNoteEdit('wn1');
    editEl.innerText = '草稿第一段+追加输入';
    window.__rejectNoteSave(new Error('disk locked'));
    await pSave;
    const keptSessionOnFail = editingNoteId === 'wn1' && document.getElementById('noteEdit_wn1').innerText.includes('追加输入');

    // 2. IME composition blocks NOTE_UPDATED redraw until compositionend.
    window.__failNoteUpdate = false;
    editEl = document.getElementById('noteEdit_wn1');
    editEl.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    window.__wDataChange({ patch: { action: 'NOTE_UPDATED', id: 'wn1' } });
    await new Promise(r => setTimeout(r, 40));
    const imePreserved = document.getElementById('noteEdit_wn1') === editEl;
    editEl.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await new Promise(r => setTimeout(r, 40));

    // 3. Peer deletes wn1 -> rescued into rescueDraftBar without overwriting quickInput.
    window.__wNotes = [];
    window.__wDataChange({ patch: { action: 'NOTE_DELETED', id: 'wn1' } });
    await new Promise(r => setTimeout(r, 80));
    const rescuedBarVisible = !document.getElementById('rescueDraftBar').hidden;
    const quickInputUntouched = qi.value === '正在输入的快速便签';
    document.getElementById('rescueRestoreBtn').click();
    await new Promise(r => setTimeout(r, 80));
    const restoredAsNewNote = window.__wNotes.some(n => n.content.includes('追加输入'));

    // 4. In-flight renderNotes response cannot overwrite tasks tab after switchTab.
    let resolveLateNotes;
    const origNotesList = api.notes.list;
    api.notes.list = () => new Promise(resolve => { resolveLateNotes = resolve; });
    const pLateNotes = renderNotes(document.getElementById('widgetBody'));
    switchTab('tasks');
    await new Promise(r => setTimeout(r, 60));
    resolveLateNotes(JSON.parse(JSON.stringify(window.__wNotes)));
    await pLateNotes;
    api.notes.list = origNotesList;
    const staleNotesSkippedOnTasksTab = currentTab === 'tasks' && !!document.querySelector('.task-item');

    return {
      taskTypingDuringRefresh,
      taskImeSameDom,
      taskImeValueAfterComp,
      taskTypingDuringSave,
      taskKeptOnFail,
      keptSessionOnFail,
      imePreserved,
      rescuedBarVisible,
      quickInputUntouched,
      restoredAsNewNote,
      staleNotesSkippedOnTasksTab,
    };
  })()`, true);
  widgetWin.destroy();
  for (const [name, passed] of Object.entries(widgetAudit)) assert(passed, `widget ${name}`);
  console.log('PASS UI: widget draft rescue, pending save typing, IME guard and quickInput isolation');
  app.exit(0);
}).catch(error => { console.error(error); if (win) win.destroy(); app.exit(1); });
