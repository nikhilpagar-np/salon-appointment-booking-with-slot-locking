const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let child; let base; let secret = 'test-webhook-secret';
async function raw(pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => null);
  return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function waitForServer() { for (let i = 0; i < 100; i += 1) { try { if ((await fetch(base + '/api/health')).ok) return; } catch (_) {} await new Promise((r) => setTimeout(r, 25)); } throw new Error('server did not start'); }
async function register(email, role = 'CUSTOMER') { const result = await raw('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 'long-secure-password', name: email.split('@')[0], role, salonId: 'salon-demo' }) }); assert.equal(result.status, 201); return result.cookie; }
const slot = (time) => ({ salonId: 'salon-demo', staffId: 'staff-demo', serviceId: 'service-demo', startsAt: `2030-01-01T${time}:00.000Z` });

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-enterprise-')); const port = 3600 + Math.floor(Math.random() * 200);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DB_PATH: path.join(dir, 'test.db'), LOCK_DURATION_MS: '1000', PAYMENT_WEBHOOK_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk)); await waitForServer();
});
test.after(() => child?.kill('SIGTERM'));

test('unauthenticated requests are rejected and sessions identify the server-side user', async () => {
  assert.equal((await raw('/api/appointments/me')).status, 401);
  const cookie = await register('session@example.com');
  const me = await raw('/api/auth/me', { headers: { cookie } });
  assert.equal(me.status, 200); assert.equal(me.body.user.email, 'session@example.com');
});

test('concurrent holds are limited per staff member and ownership is enforced', async () => {
  const cookies = await Promise.all(['user-a@example.com', 'user-b@example.com', 'user-c@example.com'].map((email) => register(email)));
  const attempts = await Promise.all(cookies.map((cookie) => raw('/api/holds', { method: 'POST', headers: { cookie }, body: JSON.stringify(slot('10:00')) })));
  assert.equal(attempts.filter((r) => r.status === 201).length, 1);
  assert.equal(attempts.filter((r) => r.status === 409).length, 2);
  const winner = attempts.find((r) => r.status === 201);
  const wrongOwner = await raw(`/api/holds/${winner.body.holdId}`, { method: 'DELETE', headers: { cookie: cookies[1] } });
  assert.deepEqual(wrongOwner.body, { released: false });
});

test('overlapping service-duration appointments are rejected', async () => {
  const firstCookie = await register('duration-a@example.com');
  const first = await raw('/api/holds', { method: 'POST', headers: { cookie: firstCookie }, body: JSON.stringify(slot('11:00')) });
  assert.equal(first.status, 201);
  const overlapCookie = await register('duration-b@example.com');
  const overlap = await raw('/api/holds', { method: 'POST', headers: { cookie: overlapCookie }, body: JSON.stringify(slot('11:15')) });
  assert.equal(overlap.status, 409);
});

test('expired holds are released and customer data is isolated', async () => {
  const cookie = await register('expiry@example.com');
  const held = await raw('/api/holds', { method: 'POST', headers: { cookie }, body: JSON.stringify(slot('12:00')) });
  assert.equal(held.status, 201); await new Promise((r) => setTimeout(r, 1150));
  const status = await raw('/api/slots/status?' + new URLSearchParams({ ...slot('12:00') }).toString(), { headers: { cookie } });
  assert.equal(status.body.available, true);
  const other = await register('other@example.com');
  const mine = await raw('/api/appointments/me', { headers: { cookie: other } });
  assert.equal(mine.body.length, 0);
});

test('online booking requires a verified payment webhook and ignores client paymentStatus', async () => {
  const cookie = await register('payment@example.com');
  const held = await raw('/api/holds', { method: 'POST', headers: { cookie }, body: JSON.stringify(slot('13:00')) });
  const unverified = await raw('/api/appointments', { method: 'POST', headers: { cookie }, body: JSON.stringify({ holdId: held.body.holdId, paymentMode: 'online', paymentStatus: 'VERIFIED' }) });
  assert.equal(unverified.status, 402);
  const intent = await raw('/api/payments/intents', { method: 'POST', headers: { cookie }, body: JSON.stringify({ serviceId: 'service-demo' }) });
  const event = JSON.stringify({ providerReference: intent.body.providerReference, amount: intent.body.amount, status: 'VERIFIED' });
  const signature = crypto.createHmac('sha256', secret).update(event).digest('hex');
  const webhook = await raw('/api/payments/webhook', { method: 'POST', headers: { 'x-payment-signature': signature }, body: event });
  assert.equal(webhook.status, 200);
  const confirmed = await raw('/api/appointments', { method: 'POST', headers: { cookie }, body: JSON.stringify({ holdId: held.body.holdId, paymentMode: 'online', paymentReference: intent.body.providerReference }) });
  assert.equal(confirmed.status, 201); assert.equal(confirmed.body.paymentStatus, 'VERIFIED');
});

test('owner role can view salon appointments but customer cannot', async () => {
  const customer = await register('role-customer@example.com');
  const owner = await register('role-owner@example.com', 'OWNER');
  const customerResponse = await raw('/api/appointments/salon', { headers: { cookie: customer } });
  const ownerResponse = await raw('/api/appointments/salon', { headers: { cookie: owner } });
  assert.equal(customerResponse.status, 403); assert.equal(ownerResponse.status, 200);
});
