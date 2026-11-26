'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ROOT = path.resolve(__dirname, '..');
const DataStore = require('../src/main/data-store');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-compat-audit-'));
  const store = new DataStore(path.join(dir, 'tasks.json'));
  store._saveDelay = 60000;
  store._buildChildrenMap();
  t.after(() => { clearTimeout(store._saveTimeout); fs.rmSync(dir, {recursive:true, force:true}); });
  return store;
}

test('compat batch creation updates its immediate auto-planned parent', t => {
  const store = fixture(t);
  store.data.config.autoPlan = true;
  const parent = store.createTask({content:'parent'});
  store.batchCreateTasks([{content:'child', parentId:parent.id, deadline:'2026-11-30'}]);
  assert.equal(store.data.tasks.find(task => task.id === parent.id).deadline, '2026-11-30');
});

test('compat merge imports missing/newer notes and preserves newer local notes', t => {
  const store = fixture(t);
  const note = store.createNote({content:'local'});
  store.data.notes[0].updatedAt = '2026-11-12T00:00:00Z';
  store.importSnapshot({tasks:[], notes:[
    {...note, content:'old', updatedAt:'2020-01-01T00:00:00Z'},
    {id:'missing', content:'imported', updatedAt:'2026-11-12T00:00:00Z'},
  ]}, 'merge');
  assert.equal(store.getNotes().find(n=>n.id===note.id).content, 'local');
  assert.equal(store.getNotes().find(n=>n.id==='missing')?.content, 'imported');
  store.importSnapshot({tasks:[], notes:[{...note,content:'newer',updatedAt:'2099-01-01T00:00:00Z'}]}, 'merge');
  assert.equal(store.getNotes().find(n=>n.id===note.id).content, 'newer');
});

test('compat corrupt startup data is readable only after repair and never overwritten', async t => {
  const store = fixture(t);
  fs.writeFileSync(store.dataFile, '{broken-json');
  store.load();
  assert.throws(()=>store.getAll());
  assert.throws(()=>store.createTask({content:'must not save'}));
  assert.throws(()=>store._forceSaveSync());
  await assert.rejects(store._saveAsync());
  assert.equal(fs.readFileSync(store.dataFile,'utf8'), '{broken-json');
  fs.writeFileSync(store.dataFile, JSON.stringify({tasks:[],notes:[]}));
  store.load();
  assert.equal(store.createTask({content:'after recovery'}).content, 'after recovery');
});

test('compat cleanup returns deleted IDs and promoted child snapshots', t => {
  const store = fixture(t);
  const parent = store.createTask({content:'old parent'});
  const child = store.createTask({content:'survivor',parentId:parent.id});
  Object.assign(store.data.tasks.find(t=>t.id===parent.id), {completed:true, completedAt:'2000-01-01T00:00:00Z'});
  const result = store.cleanupOldCompleted();
  assert(result.deleted.includes(parent.id));
  assert.equal(result.promotedTasks.find(t=>t.id===child.id).parentId, null);
});

test('compat restoring a sixth-level task is rejected without changing it', t => {
  const store = fixture(t);
  let parentId = null;
  for(let i=0;i<6;i++) {
    const id='t'+i;
    store.data.tasks.push({id,content:id,parentId,completed:true});
    parentId=id;
  }
  store.data.tasks.slice(0,5).forEach(t=>{t.completed=false;});
  store._buildChildrenMap();
  const before=JSON.stringify(store.data.tasks);
  assert.throws(()=>store.uncompleteTask('t5'));
  assert.equal(JSON.stringify(store.data.tasks),before);
  assert.equal(store.data.tasks.find(t=>t.id==='t5').completed,true);
});

test('compat task undo preserves notes while import undo restores them', () => {
  const source=fs.readFileSync(path.join(ROOT,'src/main/main.js'),'utf8');
  const start=source.indexOf("ipcMain.handle('undo:undo'");
  const end=source.indexOf("ipcMain.handle('undo:clear'",start);
  for(const [label,expected] of [['新建任务','new note'],['导入数据','old note']]) {
    let undo;
    const sandbox={
      ipcMain:{handle:(_name,fn)=>{undo=fn;}},
      undoStack:[{label,data:{tasks:[],notes:[{content:'old note'}],weeklyReports:[],deletedWeeklyReports:[],config:{}}}],
      store:{data:{tasks:[],notes:[{content:'new note'}],weeklyReports:[],deletedWeeklyReports:[],config:{}},save(){}},
      broadcastDataChanged(){},
    };
    vm.runInNewContext(source.slice(start,end),sandbox);
    undo({sender:{}});
    assert.equal(sandbox.store.data.notes[0].content,expected,label);
  }
});

test('compat notifications request a full peer task reload and skip the sender', () => {
  const source=fs.readFileSync(path.join(ROOT,'src/main/main.js'),'utf8');
  const code=source.match(/function broadcastDataChanged\(patch, exceptSender = null\) \{[\s\S]*?\n\}/)[0];
  const sent=[];
  const peer={send:(_event,payload)=>sent.push(payload)};
  const sender={send:()=>{throw Error('sender echo');}};
  const sandbox={widgetWindow:{isDestroyed:()=>false,webContents:peer},mainWindow:{isDestroyed:()=>false,webContents:sender}};
  vm.runInNewContext(code+'\nglobalThis.broadcast=broadcastDataChanged;',sandbox);
  sandbox.broadcast({action:'TASKS_BATCH_COMPLETED',ids:['parent']},sender);
  assert.equal(sent[0].patch.reloadTasks,true);
});

test('compat Local IPC sends cascade deletion and full peer reload metadata', async t => {
  const store=fixture(t);
  const parent=store.createTask({content:'parent'});
  const child=store.createTask({content:'child',parentId:parent.id});
  const source=fs.readFileSync(path.join(ROOT,'src/main/local-ipc.js'),'utf8');
  const sandbox={require,module:{exports:{}},process,Buffer,console,setTimeout,clearTimeout};
  vm.runInNewContext(source+'\nmodule.exports.handle=handleIpcRequest;',sandbox);
  const changes=[];
  await sandbox.module.exports.handle({method:'tasks:delete',params:{id:parent.id}},store,patch=>changes.push(patch));
  assert(changes[0].payload.deleted.includes(child.id));
  assert.equal(changes[0].reloadTasks,true);
});

test('compat image grants are isolated by window and expire without invalidating other windows', () => {
  const Grants=require('../src/main/image-save-authorizations');
  let now=100;
  const grants=new Grants(()=>now);
  const first=grants.authorize(1,'first.png'),second=grants.authorize(2,'second.png');
  assert.throws(()=>grants.consume(2,'first.png',first));
  assert.throws(()=>grants.consume(1,'other.png',first));
  grants.consume(1,'first.png',first);
  assert.throws(()=>grants.consume(1,'first.png',first));
  grants.consume(2,'second.png',second);
  const expired=grants.authorize(1,'expired.png');
  now+=10*60*1000;
  assert.throws(()=>grants.consume(1,'expired.png',expired));
});

test('legacy batch completion delta applies the complete descendant payload', () => {
  const source=fs.readFileSync(path.join(ROOT,'src/renderer/app.js'),'utf8');
  const start=source.indexOf('function applyPeerDelta('),end=source.indexOf('_api.onDataChange',start);
  const state={tasks:[{id:'parent',completed:false},{id:'child',completed:false}]};
  const sandbox={window:{ModuleApp:{State:{state,patch: patch=>Object.assign(state,patch)}}}};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.apply=applyPeerDelta;',sandbox);
  assert.equal(sandbox.apply({action:'TASKS_BATCH_COMPLETED',ids:['parent'],payload:{completed:[{id:'parent'},{id:'child'}]}}),true);
  assert(state.tasks.every(task=>task.completed));
});

test('compat merge honors report tombstones just like the native backend', t => {
  const store=fixture(t);
  store.data.deletedWeeklyReports=['2026-W45'];
  store.importSnapshot({tasks:[],notes:[],weeklyReports:[{weekId:'2026-W45',generatedAt:'2099-01-01T00:00:00Z',entries:[],count:0}]},'merge');
  assert.equal(store.getWeeklyReport('2026-W45'),undefined);
  assert(store.data.deletedWeeklyReports.includes('2026-W45'));
});

test('compat creation rejects missing or completed parents before adding invisible children', t => {
  const store=fixture(t);
  assert.throws(()=>store.createTask({content:'orphan',parentId:'missing'}));
  const parent=store.createTask({content:'completed parent'});
  store.completeTask(parent.id);
  assert.throws(()=>store.createTask({content:'hidden child',parentId:parent.id}));
  const before=JSON.stringify(store.data.tasks);
  assert.throws(()=>store.batchCreateTasks([{content:'valid root'},{content:'invalid child',parentId:'missing'}]));
  assert.equal(JSON.stringify(store.data.tasks),before);
});
