'use strict';
/** 无 Electron：ProjectScope 纯函数单测 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../src/renderer/shared/project-scope.js'), 'utf8');
const sandbox = { window: {}, console };
vm.runInNewContext(src, sandbox);
const PS = sandbox.window.ModuleApp.ProjectScope;

const tasks = [
  { id: 'A', content: '项目A', parentId: null, completed: false, order: 0 },
  { id: 'a1', content: '子', parentId: 'A', completed: false, order: 0 },
  { id: 'a2', content: '孙', parentId: 'a1', completed: false, order: 0 },
  { id: 'B', content: '项目B', parentId: null, completed: false, order: 1 },
  { id: 'b1', content: 'B子', parentId: 'B', completed: false, order: 0 },
  { id: 'C', content: '已完成项目', parentId: null, completed: true, order: 2 },
];

let failed = 0;
function assert(c, m) {
  console.log(c ? '  PASS' : '  FAIL', m);
  if (!c) failed++;
}

assert(PS.filterTasksByProjectScope(tasks, []).length === 6, '空 scope = 全部');
const fa = PS.filterTasksByProjectScope(tasks, ['A']);
assert(fa.map(t => t.id).sort().join(',') === 'A,a1,a2', '单项目子树');
assert(PS.listProjectRoots(tasks).map(t => t.id).join(',') === 'A,B', '下拉不含已完成顶层');
assert(PS.scrubScopeIds(tasks, ['A', 'C', 'gone']).join(',') === 'A', 'scrub 踢已完成与缺失');
assert(PS.defaultCreateParentId({ projectScopeIds: ['A'] }).parentId === 'A', '默认父级');
assert(PS.defaultCreateParentId({ projectScopeIds: [] }).parentId === null, '全部时默认顶层');

console.log(failed ? '\nFAILED ' + failed : '\nALL PASS');
process.exit(failed ? 1 : 0);
