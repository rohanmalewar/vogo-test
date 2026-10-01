const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./webhooks');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

const post = async (body) => {
  const res = await fetch(`${base}/webhooks/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const get = async (id) => (await fetch(`${base}/bookings/${id}`)).json();
const logFor = (id) => server.store.log.filter((e) => e.booking_id === id);

const ev = (booking_id, status, sent_at) => ({ booking_id, property_id: 'prop_88', status, sent_at });

test('in-order delivery applies each transition', async () => {
  await post(ev('bk_1', 'pending', '2026-08-03T14:00:00Z'));
  await post(ev('bk_1', 'confirmed', '2026-08-03T14:10:00Z'));
  assert.equal((await get('bk_1')).status, 'confirmed');
  assert.equal(logFor('bk_1').length, 2);
});

test('duplicates are processed exactly once', async () => {
  const e = ev('bk_2', 'confirmed', '2026-08-03T14:22:05Z');
  const results = await Promise.all([post(e), post(e), post(e), post(e)]);
  const outcomes = results.map((r) => r.body.result).sort();
  assert.deepEqual(outcomes, ['applied', 'duplicate', 'duplicate', 'duplicate']);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(logFor('bk_2').length, 1);
});

test('out-of-order: cancelled arrives before the confirmed it supersedes', async () => {
  const cancelled = await post(ev('bk_3', 'cancelled', '2026-08-03T15:00:00Z'));
  const confirmed = await post(ev('bk_3', 'confirmed', '2026-08-03T14:00:00Z'));
  const pending = await post(ev('bk_3', 'pending', '2026-08-03T13:00:00Z'));
  assert.equal(cancelled.body.result, 'applied');
  assert.equal(confirmed.body.result, 'stale');
  assert.equal(pending.body.result, 'stale');
  assert.equal((await get('bk_3')).status, 'cancelled');
  assert.equal(logFor('bk_3').length, 1);
});

test('shuffled stream with duplicates converges to the latest state', async () => {
  const p = ev('bk_4', 'pending', '2026-08-03T10:00:00Z');
  const c = ev('bk_4', 'confirmed', '2026-08-03T11:00:00Z');
  const x = ev('bk_4', 'cancelled', '2026-08-03T12:00:00Z');
  for (const e of [c, p, c, x, p, x, c]) await post(e);
  const final = await get('bk_4');
  assert.equal(final.status, 'cancelled');
  assert.equal(final.sent_at, '2026-08-03T12:00:00Z');
  // confirmed applied first, then cancelled; pending was stale on arrival.
  assert.deepEqual(logFor('bk_4').map((e) => e.status), ['confirmed', 'cancelled']);
});

test('concurrent out-of-order events with duplicates converge to the latest state', async () => {
  for (let run = 0; run < 20; run++) {
    const id = `bk_conc_${run}`;
    const p = ev(id, 'pending', '2026-08-03T10:00:00Z');
    const c = ev(id, 'confirmed', '2026-08-03T11:00:00Z');
    const x = ev(id, 'cancelled', '2026-08-03T12:00:00Z');
    const events = [p, c, x, p, c, x, c, x].sort(() => Math.random() - 0.5);
    const results = await Promise.all(events.map(post));

    assert.equal((await get(id)).status, 'cancelled');
    // Each distinct event is handled once; the other copies are duplicates.
    assert.equal(results.filter((r) => r.body.result !== 'duplicate').length, 3);
    // State only ever moves forward in time, whatever the arrival order.
    const applied = logFor(id).map((e) => Date.parse(e.sent_at));
    assert.deepEqual(applied, [...applied].sort((a, b) => a - b));
    assert.equal(logFor(id).at(-1).status, 'cancelled');
  }
});

test('same sent_at, different status: further-along status wins regardless of order', async () => {
  const t = '2026-08-03T16:00:00Z';
  await post(ev('bk_5', 'cancelled', t));
  await post(ev('bk_5', 'confirmed', t));
  assert.equal((await get('bk_5')).status, 'cancelled');
});

test('bookings are independent of each other', async () => {
  await post(ev('bk_6', 'cancelled', '2026-08-03T18:00:00Z'));
  await post(ev('bk_7', 'confirmed', '2026-08-03T09:00:00Z'));
  assert.equal((await get('bk_6')).status, 'cancelled');
  assert.equal((await get('bk_7')).status, 'confirmed');
});

test('rejects invalid payloads with 400', async () => {
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post(ev('bk_8', 'shipped', '2026-08-03T14:00:00Z'))).status, 400);
  assert.equal((await post(ev('bk_8', 'pending', 'yesterday'))).status, 400);
  assert.equal((await post({ booking_id: 'bk_8' })).status, 400);
});
