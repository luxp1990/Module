// 周报功能全功能测试（数据层 + 渲染层 + 终态收尾判定）
// 运行：node tests/_test_weekly_report.js
const path = require('path');
const os = require('os');
const fs = require('fs');

const DataStore = require(path.resolve(__dirname, '../src/main/data-store.js'));

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n═══ ' + t + ' ═══'); }

const TZ = new Date().getTimezoneOffset(); // UTC+8 = -480
console.log('本机时区偏移 getTimezoneOffset =', TZ, '(UTC+8 应为 -480)');
const OFF = TZ * 60000; // 毫秒偏移

// ============ 数据层测试 ============
section('A. ISO 周计算 getWeekId / getWeekRange');
{
  const s = new DataStore(path.join(os.tmpdir(), 'wtest-a-' + Date.now() + '.json'));
  const d = (y, m, dd) => new Date(y, m - 1, dd);
  assert('2026-08-18(周二) = 2026-W34', s.getWeekId(d(2026, 8, 18)) === '2026-W34');
  assert('2026-08-10(周一) = 2026-W33', s.getWeekId(d(2026, 8, 10)) === '2026-W33');
  assert('2026-08-16(周日) = 2026-W33', s.getWeekId(d(2026, 8, 16)) === '2026-W33');
  assert('2026-08-17(周一) = 2026-W34', s.getWeekId(d(2026, 8, 17)) === '2026-W34');
  assert('跨年 2025-12-29(周一) = 2026-W01', s.getWeekId(d(2025, 12, 29)) === '2026-W01');
  assert('跨年 2026-01-01 = 2026-W01', s.getWeekId(d(2026, 1, 1)) === '2026-W01');

  const r = s.getWeekRange('2026-W33');
  assert('W33 start = 2026-08-10 UTC', r.start.toISOString() === '2026-08-10T00:00:00.000Z', r.start.toISOString());
  assert('W33 end   = 2026-08-16 UTC', r.end.toISOString() === '2026-08-16T00:00:00.000Z', r.end.toISOString());
  // 清理可能的临时文件
  try { fs.rmSync(s.dataFile, { force: true }); } catch (_) {}
}

section('B. generateWeeklyReport 日期边界（时区无关，动态计算本地周界）');
{
  const s = new DataStore(path.join(os.tmpdir(), 'wtest-b-' + Date.now() + '.json'));
  const { start, end } = s.getWeekRange('2026-W33');
  const monLocal = start.getTime() + OFF;        // 本地周一 00:00
  const sunLocalEnd = end.getTime() + OFF + 86400000 - 1; // 本地周日 23:59:59.999
  const nextMonLocal = end.getTime() + OFF + 86400000;    // 本地下周一 00:00

  s.data.tasks = [
    { id: 'a', content: '周一起点任务', parentId: null, completed: true,  completedAt: new Date(monLocal).toISOString() },
    { id: 'b', content: '周日最后一刻任务', parentId: null, completed: true, completedAt: new Date(sunLocalEnd).toISOString() },
    { id: 'c', content: '下周一才完成(不该算)', parentId: null, completed: true, completedAt: new Date(nextMonLocal).toISOString() },
    { id: 'd', content: '上周日完成(不该算)', parentId: null, completed: true, completedAt: new Date(monLocal - 1).toISOString() },
    { id: 'e', content: '未完成任务(不该算)', parentId: null, completed: false, completedAt: new Date(monLocal).toISOString() },
  ];
  s._buildChildrenMap();

  const rep = s.generateWeeklyReport('2026-W33');
  assert('count = 2（a+b 纳入，c/d/e 排除）', rep.count === 2, '实际 ' + rep.count);
  const contents = rep.entries.map(e => e.content).sort();
  assert('包含 a、b 两项', contents.length === 2 && contents.includes('周一起点任务') && contents.includes('周日最后一刻任务'), JSON.stringify(contents));

  // 父任务聚合字段
  s.data.tasks.push(
    { id: 'p1', content: '母任务X', parentId: null, completed: false, completedAt: null },
    { id: 'f', content: '子任务', parentId: 'p1', completed: true, completedAt: new Date(monLocal + 1000).toISOString() },
  );
  s._buildChildrenMap();
  const rep2 = s.generateWeeklyReport('2026-W33');
  const child = rep2.entries.find(e => e.content === '子任务');
  assert('子任务 parentContent = 母任务X', child && child.parentContent === '母任务X', JSON.stringify(child));
  assert('子任务 level = 1', child && child.level === 1, String(child && child.level));
  try { fs.rmSync(s.dataFile, { force: true }); } catch (_) {}
}

section('C. notes 保留 + 删除 + 重新生成');
{
  const s = new DataStore(path.join(os.tmpdir(), 'wtest-c-' + Date.now() + '.json'));
  s.data.tasks = [{ id: 'a', content: '任务', parentId: null, completed: true, completedAt: new Date().toISOString() }];
  s._buildChildrenMap();

  const w = s.getWeekId(new Date());
  s.generateWeeklyReport(w);
  s.updateWeeklyReport(w, { notes: '重要总结勿丢' });
  assert('更新后 notes 已写', s.getWeeklyReport(w).notes === '重要总结勿丢');
  s.generateWeeklyReport(w); // 重新生成
  assert('重新生成后 notes 保留', s.getWeeklyReport(w).notes === '重要总结勿丢', String(s.getWeeklyReport(w).notes));

  s.deleteWeeklyReport(w);
  assert('删除后不存在', s.getWeeklyReport(w) === undefined);
  s.generateWeeklyReport(w);
  assert('删除后可重新生成', s.getWeeklyReport(w) !== undefined && s.getWeeklyReport(w).count >= 1);
  try { fs.rmSync(s.dataFile, { force: true }); } catch (_) {}
}

section('D. 撤销快照深拷贝隔离（snapshotData 语义）');
{
  const s = new DataStore(path.join(os.tmpdir(), 'wtest-d-' + Date.now() + '.json'));
  s.data.tasks = [{ id: 'a', content: '任务', parentId: null, completed: true, completedAt: new Date().toISOString() }];
  s.data.weeklyReports = [];
  s._buildChildrenMap();
  const w = s.getWeekId(new Date());
  s.generateWeeklyReport(w);
  assert('已有一份周报', s.data.weeklyReports.length === 1);

  // 复刻 main.js snapshotData 的深拷贝
  const snapshot = {
    ...s.data,
    tasks: JSON.parse(JSON.stringify(s.data.tasks)),
    notes: JSON.parse(JSON.stringify(s.data.notes)),
    weeklyReports: JSON.parse(JSON.stringify(s.data.weeklyReports || [])),
  };

  s.deleteWeeklyReport(w); // 原地修改 s.data.weeklyReports
  assert('删除后快照仍保留旧周报(深拷贝隔离)', snapshot.weeklyReports.length === 1, '快照长度 ' + snapshot.weeklyReports.length);
  assert('删除后 live 数据已空', s.data.weeklyReports.length === 0);

  // 模拟 undo 恢复：标签含"周报"时不覆盖
  s.data.weeklyReports = snapshot.weeklyReports;
  assert('undo 恢复后周报回来了', s.data.weeklyReports.length === 1 && s.data.weeklyReports[0].weekId === w);
  try { fs.rmSync(s.dataFile, { force: true }); } catch (_) {}
}

section('E. listWeeklyReports 排序 + 保留周数上限');
{
  const s = new DataStore(path.join(os.tmpdir(), 'wtest-e-' + Date.now() + '.json'));
  s.data.config = { reportRetentionWeeks: 3 };
  s.data.weeklyReports = ['2026-W30', '2026-W33', '2026-W31', '2026-W32'].map(w => ({ weekId: w, entries: [], count: 0, notes: '' }));
  const list = s.listWeeklyReports();
  assert('按 weekId 倒序', JSON.stringify(list.map(r => r.weekId)) === JSON.stringify(['2026-W33', '2026-W32', '2026-W31']));
  assert('只保留最近 3 周', list.length === 3);
  try { fs.rmSync(s.dataFile, { force: true }); } catch (_) {}
}

section('F. tryAutoWeeklyReport 终态收尾判定（复刻核心逻辑）');
{
  const s = new DataStore(path.join(os.tmpdir(), 'wtest-f-' + Date.now() + '.json'));
  const now = new Date(2026, 7, 18, 10, 0, 0); // 2026-08-18 周二 10:00 本地
  const lastWeekId = s.getWeekId(new Date(now.getTime() - 7 * 86400000));
  const { end } = s.getWeekRange(lastWeekId);
  const endOfWeekMs = end.getTime() + OFF + 86400000 - 1; // 上周日 23:59:59.999

  function needsGen(existing) {
    return !existing || (new Date(existing.generatedAt).getTime() <= endOfWeekMs);
  }
  assert('场景1 无上周周报 → 需生成', needsGen(null) === true);
  assert('场景2 上周五快照(generatedAt 在周日23:59前) → 需重生成', needsGen({ generatedAt: new Date(endOfWeekMs - 1000).toISOString() }) === true);
  assert('场景3 周一终态(generatedAt 在周日23:59后) → 不需重生成', needsGen({ generatedAt: new Date(endOfWeekMs + 1).toISOString() }) === false);
  assert('lastWeekId = 2026-W33', lastWeekId === '2026-W33', lastWeekId);
  try { fs.rmSync(s.dataFile, { force: true }); } catch (_) {}
}

section('G0. 删除墓碑机制（防止删除后自动复活）');
{
  const s = new DataStore(path.join(os.tmpdir(), 'wtest-g0-' + Date.now() + '.json'));
  s.data.tasks = [{ id: 'a', content: '任务', parentId: null, completed: true, completedAt: new Date().toISOString() }];
  s._buildChildrenMap();
  const w = s.getWeekId(new Date());
  s.generateWeeklyReport(w);
  assert('初始无墓碑', s.isWeeklyReportDeleted(w) === false);

  s.deleteWeeklyReport(w);
  assert('删除后墓碑生效', s.isWeeklyReportDeleted(w) === true);
  assert('重复删除返回 false', s.deleteWeeklyReport(w) === false);

  // 模拟 tryAutoWeeklyReport 补漏判定：墓碑存在则不应自动生成
  const shouldAutoGen = !s.getWeeklyReport(w) && !s.isWeeklyReportDeleted(w);
  assert('删除后自动补漏被墓碑阻止', shouldAutoGen === false);

  // 用户主动点「生成周报」→ 清除墓碑
  s.generateWeeklyReport(w);
  assert('主动生成后墓碑清除', s.isWeeklyReportDeleted(w) === false);
  assert('主动生成后周报存在', s.getWeeklyReport(w) !== undefined);
  try { fs.rmSync(s.dataFile, { force: true }); } catch (_) {}
}

// ============ 渲染层测试（mock DOM） ============
section('G. reports.js 渲染层（mock 环境加载 + 结构断言）');
{
  function makeEl() { return { addEventListener(){}, dataset:{}, style:{}, focus(){}, classList:{add(){},remove(){}} }; }
  const container = {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
  };
  global.document = { getElementById() { return makeEl(); }, createElement() { return makeEl(); } };
  global.window = {
    api: {
      reports: {
        list: async () => [{
          weekId: '2026-W33',
          startDate: '2026-08-10T00:00:00.000Z',
          endDate: '2026-08-16T00:00:00.000Z',
          generatedAt: '2026-08-17T00:00:00.000Z',
          count: 3, notes: '完成关键里程碑',
          entries: [
            { taskId: 'a', content: '登录页重构', completedAt: '2026-08-10T02:00:00.000Z', level: 0, parentContent: null },
            { taskId: 'b', content: '接口联调', completedAt: '2026-08-11T03:00:00.000Z', level: 1, parentContent: '核心模块' },
            { taskId: 'c', content: '修复报错', completedAt: '2026-08-12T04:00:00.000Z', level: 1, parentContent: '核心模块' },
          ],
        }],
        generate: async () => ({ count: 2 }),
        currentWeekId: async () => '2026-W34',
        lastWeekId: async () => '2026-W33',
        update: async () => ({}),
        delete: async () => true,
      },
      writeClipboard: async () => true,
    },
    ModuleApp: { Toast: { show(){} }, Modal: { confirm: async () => true }, State: { state: { view: 'reports' } } },
  };

  // 重新加载 reports.js（此时 window 已就绪）
  const rp = path.resolve(__dirname, '../src/renderer/views/reports.js');
  delete require.cache[require.resolve(rp)];
  require(rp);
  const ReportsView = global.window.ModuleApp.ReportsView;
  assert('ReportsView 已挂载到 window.ModuleApp', !!ReportsView);

  (async () => {
    ReportsView.mount(container);
    await ReportsView.render({ view: 'reports' });
    const html = container._html;

    const mustHave = [
      ['生成本周周报按钮', 'generateReportBtn'],
      ['生成上周周报按钮', 'generateLastWeekReportBtn'],
      ['看板卡片', 'report-card enhanced'],
      ['指标胶囊 primary', 'report-metric-pill primary'],
      ['统计图表框', 'report-chart-box'],
      ['统计柱状图列', 'report-bar-col'],
      ['备注框', 'report-notes-box'],
      ['备注标签', '📝 备注'],
      ['复制文本按钮', 'data-report-copy'],
      ['视角切换 tab', 'report-tab-btn'],
      ['项目聚合块', 'report-project-block'],
      ['时间线项', 'report-timeline-item'],
    ];
    for (const [label, needle] of mustHave) assert('HTML 含「' + label + '」', html.includes(needle));

    // 默认视角应为「时间足迹」为主（timeline tab 为 active）
    assert('默认时间足迹视角 active', html.includes('report-tab-btn active" data-switch-mode="timeline"'), '未命中 timeline active');

    // _fmtDate 时区修复验证：应显示 8月10日 ~ 8月16日，而非乱码或偏移
    assert('_fmtDate 显示 8月10日~8月16日', html.includes('8月10日') && html.includes('8月16日'), html.match(/\d+月\d+日 ~ \d+月\d+日/)?.[0]);
    assert('无数组拼接乱码(2026,08,10)', !html.includes('2026,08,10') && !html.includes('2026,08,'));

    // 复制文本格式化：走 window.api.writeClipboard 而非 navigator.clipboard
    assert('复制走主进程 window.api.writeClipboard', html.includes('data-report-copy'));

    console.log('\n');
    console.log('══════════════════════════════════');
    console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
    console.log('══════════════════════════════════');
    process.exit(fail > 0 ? 1 : 0);
  })();
}
