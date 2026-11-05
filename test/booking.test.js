const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let child;
let base;
let dbPath;

async function request(pathname, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('server did not start');
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-booking-'));
  dbPath = path.join(dir, 'test.db');
  const port = 3400 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, LOCK_DURATION_MS: '120' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForServer();
});

test.after(() => child?.kill('SIGTERM'));

test('concurrent attempts never exceed capacity and a lock is owner-bound', async () => {
  const attempts = await Promise.all(['a', 'b', 'c'].map((userId) => request('/api/locks', {
    method: 'POST', headers: { 'x-user-id': userId },
    body: JSON.stringify({ salonId: 'salon-1', date: '2030-01-01', time: '10:00 AM' })
  })));
  assert.equal(attempts.filter((r) => r.status === 201).length, 2);
  assert.equal(attempts.filter((r) => r.status === 409).length, 1);
  const winner = attempts.find((r) => r.status === 201);
  const wrongOwner = await request(`/api/locks/${winner.body.lockId}`, { method: 'DELETE', headers: { 'x-user-id': 'intruder' } });
  assert.deepEqual(wrongOwner.body, { released: false });
});

test('a confirmed booking consumes capacity atomically and duplicate confirmation is rejected', async () => {
  const lock = await request('/api/locks', {
    method: 'POST', headers: { 'x-user-id': 'confirm-user' },
    body: JSON.stringify({ salonId: 'salon-2', date: '2030-01-01', time: '11:00 AM' })
  });
  assert.equal(lock.status, 201);
  const payload = { id: 'booking-1', sid: 'salon-2', date: '2030-01-01', time: '11:00 AM' };
  const confirmed = await request('/api/bookings', {
    method: 'POST', headers: { 'x-user-id': 'confirm-user' },
    body: JSON.stringify({ salonId: 'salon-2', date: payload.date, time: payload.time, bookingId: payload.id, lockId: lock.body.lockId, payload })
  });
  assert.equal(confirmed.status, 201);
  const duplicate = await request('/api/bookings', {
    method: 'POST', headers: { 'x-user-id': 'confirm-user' },
    body: JSON.stringify({ salonId: 'salon-2', date: payload.date, time: payload.time, bookingId: 'booking-duplicate', lockId: lock.body.lockId, payload })
  });
  assert.equal(duplicate.status, 409);
});

test('expired locks are released and failed payment releases the lock', async () => {
  const first = await request('/api/locks', {
    method: 'POST', headers: { 'x-user-id': 'expiring-user' },
    body: JSON.stringify({ salonId: 'salon-3', date: '2030-01-01', time: '12:00 PM' })
  });
  assert.equal(first.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const afterExpiry = await request('/api/slots/status?salonId=salon-3&date=2030-01-01&time=12:00%20PM');
  assert.equal(afterExpiry.body.reserved, 0);

  const failed = await request('/api/locks', {
    method: 'POST', headers: { 'x-user-id': 'failed-pay-user' },
    body: JSON.stringify({ salonId: 'salon-3', date: '2030-01-01', time: '12:00 PM' })
  });
  const paymentFailed = await request('/api/bookings', {
    method: 'POST', headers: { 'x-user-id': 'failed-pay-user' },
    body: JSON.stringify({ salonId: 'salon-3', date: '2030-01-01', time: '12:00 PM', bookingId: 'failed-1', lockId: failed.body.lockId, paymentStatus: 'failed', payload: {} })
  });
  assert.equal(paymentFailed.status, 402);
  const released = await request('/api/slots/status?salonId=salon-3&date=2030-01-01&time=12:00%20PM');
  assert.equal(released.body.reserved, 0);
});

test('different slots can be locked concurrently', async () => {
  const results = await Promise.all(['1:00 PM', '1:30 PM', '2:00 PM'].map((time, i) => request('/api/locks', {
    method: 'POST', headers: { 'x-user-id': `parallel-${i}` },
    body: JSON.stringify({ salonId: 'salon-4', date: '2030-01-01', time })
  })));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
});
