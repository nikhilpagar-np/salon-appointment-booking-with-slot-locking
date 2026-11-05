const crypto = require('node:crypto');
const { db } = require('../database/db');

const secret = () => process.env.PAYMENT_WEBHOOK_SECRET || 'development-only-change-me';
function createIntent({ serviceId, customerId }) {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  if (!service) throw Object.assign(new Error('Service is unavailable'), { status: 404 });
  const providerReference = `pay_${crypto.randomUUID()}`;
  db.prepare("INSERT INTO payments(id,appointment_id,provider,provider_reference,amount,status,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), null, 'configured-provider', providerReference, service.price, 'PENDING', Date.now());
  return { providerReference, amount: service.price, currency: 'INR', status: 'PENDING', customerId };
}
function verifyWebhook(rawBody, signature) {
  if (!signature) throw Object.assign(new Error('Payment signature is required'), { status: 401 });
  const expected = crypto.createHmac('sha256', secret()).update(rawBody).digest('hex');
  const actual = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actual)) throw Object.assign(new Error('Invalid payment signature'), { status: 401 });
}
function processWebhook(rawBody, signature) {
  verifyWebhook(rawBody, signature);
  const event = JSON.parse(rawBody);
  if (!event.providerReference || !['VERIFIED', 'FAILED'].includes(event.status)) throw Object.assign(new Error('Invalid payment event'), { status: 400 });
  const payment = db.prepare('SELECT * FROM payments WHERE provider_reference = ?').get(event.providerReference);
  if (!payment) throw Object.assign(new Error('Unknown payment reference'), { status: 404 });
  if (Number(event.amount) !== payment.amount) throw Object.assign(new Error('Payment amount mismatch'), { status: 400 });
  db.prepare('UPDATE payments SET status = ?, verified_at = ? WHERE provider_reference = ?').run(event.status, event.status === 'VERIFIED' ? Date.now() : null, event.providerReference);
  return { accepted: true, status: event.status };
}
module.exports = { createIntent, processWebhook };
