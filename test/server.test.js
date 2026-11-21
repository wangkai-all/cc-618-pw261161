'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('GET / 返回页面，业务结果区带 data-evidence-result 属性', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-evidence-result="idle"/);
  assert.match(html, /计算原替换和投诉/);
  assert.match(html, /重分配一张投诉单/);
  assert.match(html, /查看品类归因/);
});

test('POST /api/compute 正常：替补与投诉指标分开', async () => {
  const res = await fetch(`${base}/api/compute`, { method: 'POST' });
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.totals.lines, 6);
  assert.equal(m.totals.substitutedLines, 2);
  assert.equal(m.totals.countedComplaints, 1);
  assert.equal(m.totals.boundaryCases, 2);
});

test('POST /api/reassign 正常：自动归因改挂，已认领投诉总数不变', async () => {
  const res = await fetch(`${base}/api/reassign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId: 'T9001' }),
  });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.to.lineId, 'O1001-L2');
  assert.equal(r.totals.claimedBefore, r.totals.claimedAfter);

  const view = await (await fetch(`${base}/api/attribution`)).json();
  const t = view.tickets.find((x) => x.ticketId === 'T9001');
  assert.equal(t.countedIn, '月季');
});

test('POST /api/reassign 异常：未知工单 400，非法 JSON 400', async () => {
  const res = await fetch(`${base}/api/reassign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId: 'T0000' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'TICKET_NOT_FOUND');

  const bad = await fetch(`${base}/api/reassign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'BAD_JSON');
});

test('GET 未知路径 404；重置后指标恢复原状', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'NOT_FOUND');

  await fetch(`${base}/api/reset`, { method: 'POST' });
  const m = await (await fetch(`${base}/api/compute`, { method: 'POST' })).json();
  assert.equal(m.totals.countedComplaints, 1);
  assert.equal(m.totals.boundaryCases, 2);
});