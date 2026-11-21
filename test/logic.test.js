'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../src/logic');

// ---------- 正常路径 ----------

test('计算指标：替补使用率与投诉率分开统计，替换前后品类都保留', () => {
  const state = logic.createState();
  const m = logic.computeMetrics(state);

  // 6 条订单行，其中 2 条发生替补（绣球→月季、兰花→绿萝）
  assert.equal(m.totals.lines, 6);
  assert.equal(m.totals.substitutedLines, 2);
  assert.ok(Math.abs(m.totals.substitutionRate - 2 / 6) < 1e-9);

  const byCat = Object.fromEntries(m.categories.map((c) => [c.category, c]));
  // 替换前后品类保留：绣球被替补出 1 行，月季替补进来 1 行
  assert.equal(byCat['绣球'].originalLines, 1);
  assert.equal(byCat['绣球'].finalLines, 0);
  assert.equal(byCat['绣球'].substitutedOut, 1);
  assert.equal(byCat['月季'].substitutedIn, 1);
  assert.equal(byCat['月季'].finalLines, 3);
  assert.equal(byCat['绣球'].substitutionRate, 1);

  // 投诉与替补分开：只有 T9002（已认领且定位到多肉行）计入投诉率
  assert.equal(m.totals.complaintTickets, 3); // T9004 是咨询单，不算投诉
  assert.equal(m.totals.claimedComplaints, 2);
  assert.equal(m.totals.countedComplaints, 1);
  assert.equal(byCat['多肉'].complaints, 1);
  assert.deepEqual(byCat['多肉'].complaintTickets, ['T9002']);
  assert.equal(byCat['多肉'].complaintRate, 1);
});

test('边界单列：未认领工单与仅挂父订单的工单不计入投诉率', () => {
  const state = logic.createState();
  const m = logic.computeMetrics(state);
  assert.equal(m.totals.boundaryCases, 2);
  const reasons = Object.fromEntries(m.boundary.map((b) => [b.ticketId, b.reason]));
  assert.match(reasons['T9001'], /父订单/);
  assert.match(reasons['T9003'], /未认领/);
});

test('归因模块：给出候选订单行和可信度，替补行+货不对版措辞得分最高', () => {
  const state = logic.createState();
  const t9001 = state.tickets.find((t) => t.id === 'T9001');
  const att = logic.attributeTicket(t9001, state.orders);
  assert.equal(att.top.lineId, 'O1001-L2'); // 绣球→月季 的替补行
  assert.ok(att.top.confidence >= logic.CONFIDENCE_THRESHOLD);
  assert.equal(att.top.originalCategory, '绣球');
  assert.equal(att.top.finalCategory, '月季');

  // T9003 描述模糊，所有候选都低于阈值
  const t9003 = state.tickets.find((t) => t.id === 'T9003');
  const att3 = logic.attributeTicket(t9003, state.orders);
  assert.ok(att3.top.confidence < logic.CONFIDENCE_THRESHOLD);
});

test('重分配：父订单改挂到某一件，品类投诉变化且总数不重复计算', () => {
  const state = logic.createState();
  const r = logic.reassignTicket(state, 'T9001'); // 缺省 lineId → 自动归因

  assert.equal(r.auto, true);
  assert.equal(r.to.lineId, 'O1001-L2');
  assert.equal(r.to.category, '月季');
  assert.equal(r.to.substituted, true);
  assert.deepEqual(r.changes, [{ category: '月季', before: 0, after: 1 }]);

  // 没有重复算投诉：已认领总数不变，工单只是从边界桶移到品类桶
  assert.equal(r.totals.claimedBefore, 2);
  assert.equal(r.totals.claimedAfter, 2);
  assert.equal(r.totals.boundaryBefore, 2);
  assert.equal(r.totals.boundaryAfter, 1);
  assert.match(r.explanation, /月季/);
  assert.match(r.explanation, /未重复计算/);

  const m = logic.computeMetrics(state);
  const byCat = Object.fromEntries(m.categories.map((c) => [c.category, c]));
  assert.equal(byCat['月季'].complaints, 1);
  assert.equal(byCat['多肉'].complaints, 1); // 原有投诉不受影响
  assert.equal(m.totals.countedComplaints, 2);
});

test('重分配：从一件改到另一件，两个品类一减一增、总数守恒', () => {
  const state = logic.createState();
  const r = logic.reassignTicket(state, 'T9002', 'O1002-L2'); // 多肉行 → 绿萝行

  assert.equal(r.from.category, '多肉');
  assert.equal(r.to.category, '绿萝');
  const delta = Object.fromEntries(r.changes.map((c) => [c.category, c]));
  assert.deepEqual(delta['多肉'], { category: '多肉', before: 1, after: 0 });
  assert.deepEqual(delta['绿萝'], { category: '绿萝', before: 0, after: 1 });
  assert.equal(r.totals.countedBefore, 1);
  assert.equal(r.totals.countedAfter, 1); // 移动而非复制，总数不变
});

// ---------- 异常路径 ----------

test('异常：工单不存在', () => {
  const state = logic.createState();
  assert.throws(() => logic.reassignTicket(state, 'T0000'), (err) => {
    assert.equal(err.code, 'TICKET_NOT_FOUND');
    return true;
  });
});

test('异常：非投诉工单不能重分配', () => {
  const state = logic.createState();
  assert.throws(() => logic.reassignTicket(state, 'T9004'), (err) => {
    assert.equal(err.code, 'NOT_COMPLAINT');
    return true;
  });
});

test('异常：订单行不存在 / 不属于该工单的父订单', () => {
  const state = logic.createState();
  assert.throws(() => logic.reassignTicket(state, 'T9001', 'O9999-L9'), (err) => {
    assert.equal(err.code, 'LINE_NOT_FOUND');
    return true;
  });
  assert.throws(() => logic.reassignTicket(state, 'T9001', 'O1002-L1'), (err) => {
    assert.equal(err.code, 'LINE_ORDER_MISMATCH');
    return true;
  });
});

test('异常：自动归因可信度不足时拒绝改挂，且状态不被污染', () => {
  const state = logic.createState();
  assert.throws(() => logic.reassignTicket(state, 'T9003'), (err) => {
    assert.equal(err.code, 'LOW_CONFIDENCE');
    assert.ok(Array.isArray(err.extra.candidates));
    return true;
  });
  const t = state.tickets.find((x) => x.id === 'T9003');
  assert.equal(t.lineId, null); // 仍是边界个案
  const m = logic.computeMetrics(state);
  assert.equal(m.totals.countedComplaints, 1);
  assert.equal(m.totals.boundaryCases, 2);
});
