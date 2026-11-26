'use strict';
/** 拖拽深度：已完成子孙不应抬高 active 子树深度 */
function getSubtreeMaxDepthActive(tasks, taskId) {
  const children = tasks.filter(t => t.parentId === taskId && !t.completed);
  if (children.length === 0) return 0;
  let max = 0;
  for (const child of children) max = Math.max(max, 1 + getSubtreeMaxDepthActive(tasks, child.id));
  return max;
}
function getSubtreeMaxDepthAll(tasks, taskId) {
  const children = tasks.filter(t => t.parentId === taskId);
  if (children.length === 0) return 0;
  let max = 0;
  for (const child of children) max = Math.max(max, 1 + getSubtreeMaxDepthAll(tasks, child.id));
  return max;
}

const tasks = [
  { id: 'M', parentId: null, completed: false },
  { id: 'c1', parentId: 'M', completed: true },
  { id: 'c2', parentId: 'c1', completed: true },
  { id: 'c3', parentId: 'c2', completed: true },
];

let failed = 0;
function assert(c, m) {
  console.log(c ? '  PASS' : '  FAIL', m);
  if (!c) failed++;
}

const allD = getSubtreeMaxDepthAll(tasks, 'M');
const actD = getSubtreeMaxDepthActive(tasks, 'M');
console.log({ allD, actD });
assert(allD === 3, '含已完成时深度=3（旧行为）');
assert(actD === 0, '仅未完成时 M 视为叶子 depth=0');

// 拖到三级下为子：newLevel=4, depth=0 → 4+0<=4 允许；旧 depth=3 → 拒绝
const maxLv = 4;
assert(4 + actD <= maxLv, '新规则允许挂到三级下');
assert(4 + allD > maxLv, '旧规则会误拒');

console.log(failed ? '\nFAILED ' + failed : '\nALL PASS');
process.exit(failed ? 1 : 0);
