const crypto = require('node:crypto');
const { db } = require('../database/db');
const env = require('../config/env');

function bad(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function cleanup(now = Date.now()) { db.prepare('DELETE FROM slot_holds WHERE expires_at <= ?').run(now); }
function parseLegacy(date, time) {
  const match = String(time).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) bad('time must be a valid 12-hour time');
  let hour = Number(match[1]) % 12; if (match[3].toUpperCase() === 'PM') hour += 12;
  const value = `${date}T${String(hour).padStart(2, '0')}:${match[2]}:00`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) bad('date is invalid');
  return parsed;
}
function resolveRequest(input, customerId) {
  const salonId = String(input.salonId || 'salon-demo');
  const staff = input.staffId ? db.prepare('SELECT * FROM staff WHERE id = ? AND salon_id = ? AND active = 1').get(input.staffId, salonId) : db.prepare('SELECT * FROM staff WHERE salon_id = ? AND active = 1 LIMIT 1').get(salonId);
  if (!staff) bad('Staff member is unavailable', 409);
  const service = input.serviceId ? db.prepare('SELECT * FROM services WHERE id = ? AND salon_id = ? AND active = 1').get(input.serviceId, salonId) : db.prepare('SELECT * FROM services WHERE salon_id = ? AND active = 1 LIMIT 1').get(salonId);
  if (!service) bad('Service is unavailable', 409);
  const assignment = db.prepare('SELECT 1 FROM staff_services WHERE staff_id = ? AND service_id = ?').get(staff.id, service.id);
  if (!assignment) bad('Staff member cannot perform this service', 409);
  const starts = input.startsAt ? new Date(input.startsAt) : parseLegacy(input.date, input.time);
  if (Number.isNaN(starts.getTime())) bad('startsAt is invalid');
  const ends = new Date(starts.getTime() + service.duration_minutes * 60 * 1000);
  return { salonId, staff, service, startsAt: starts.toISOString(), endsAt: ends.toISOString(), customerId };
}
function withinSchedule(staffId, startsAt, endsAt) {
  const starts = new Date(startsAt); const ends = new Date(endsAt);
  const weekday = starts.getUTCDay();
  const startMinute = starts.getUTCHours() * 60 + starts.getUTCMinutes();
  const endMinute = ends.getUTCHours() * 60 + ends.getUTCMinutes();
  return Boolean(db.prepare(`SELECT 1 FROM staff_schedules WHERE staff_id = ? AND weekday = ? AND start_minute <= ? AND end_minute >= ?`).get(staffId, weekday, startMinute, endMinute));
}
function conflicts(staffId, startsAt, endsAt, now) {
  const hold = db.prepare(`SELECT 1 FROM slot_holds WHERE staff_id = ? AND expires_at > ? AND starts_at < ? AND ends_at > ? LIMIT 1`).get(staffId, now, endsAt, startsAt);
  const appointment = db.prepare(`SELECT 1 FROM appointments WHERE staff_id = ? AND status = 'CONFIRMED' AND starts_at < ? AND ends_at > ? LIMIT 1`).get(staffId, endsAt, startsAt);
  return Boolean(hold || appointment);
}
function status(input, customerId = null) {
  cleanup(); const data = resolveRequest(input, customerId || 'anonymous');
  const now = Date.now();
  const heldByMe = customerId && db.prepare('SELECT id,expires_at FROM slot_holds WHERE customer_id = ? AND staff_id = ? AND starts_at = ? AND expires_at > ?').get(customerId, data.staff.id, data.startsAt, now);
  return { salonId: data.salonId, staffId: data.staff.id, serviceId: data.service.id, startsAt: data.startsAt, endsAt: data.endsAt, price: data.service.price, durationMinutes: data.service.duration_minutes, available: withinSchedule(data.staff.id, data.startsAt, data.endsAt) && (!conflicts(data.staff.id, data.startsAt, data.endsAt, now) || Boolean(heldByMe)), heldByMe: Boolean(heldByMe) };
}
function hold(input, customerId) {
  const now = Date.now(); const data = resolveRequest(input, customerId);
  const result = db.transaction(() => {
    cleanup(now);
    if (!withinSchedule(data.staff.id, data.startsAt, data.endsAt)) bad('Appointment is outside staff working hours', 409);
    if (conflicts(data.staff.id, data.startsAt, data.endsAt, now)) bad('Staff member is already booked for that time', 409);
    const id = `hold_${crypto.randomUUID()}`;
    const expiresAt = now + env.lockDurationMs;
    db.prepare('INSERT INTO slot_holds(id,salon_id,staff_id,customer_id,service_id,starts_at,ends_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, data.salonId, data.staff.id, customerId, data.service.id, data.startsAt, data.endsAt, expiresAt, now);
    return { holdId: id, expiresAt, ...status(input, customerId) };
  })();
  return result;
}
function release(holdId, customerId) {
  return { released: db.prepare('DELETE FROM slot_holds WHERE id = ? AND customer_id = ?').run(holdId, customerId).changes > 0 };
}
function confirm(input, customerId) {
  const now = Date.now();
  return db.transaction(() => {
    cleanup(now);
    const hold = db.prepare('SELECT * FROM slot_holds WHERE id = ? AND customer_id = ? AND expires_at > ?').get(input.holdId, customerId, now);
    if (!hold) bad('Hold expired or does not belong to this customer', 409);
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(hold.service_id);
    const paymentMode = input.paymentMode === 'online' ? 'online' : 'at_salon';
    let paymentStatus = 'PENDING'; let paymentReference = null;
    if (paymentMode === 'online') {
      if (!input.paymentReference) bad('Verified payment reference is required', 402);
      const payment = db.prepare("SELECT * FROM payments WHERE provider_reference = ? AND status = 'VERIFIED'").get(input.paymentReference);
      if (!payment || payment.amount !== service.price) bad('Payment has not been verified for this service amount', 402);
      paymentStatus = 'VERIFIED'; paymentReference = payment.provider_reference;
    }
    const id = String(input.bookingId || `appt_${crypto.randomUUID()}`);
    db.prepare('INSERT INTO appointments(id,salon_id,staff_id,customer_id,service_id,starts_at,ends_at,status,payment_status,payment_reference,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, hold.salon_id, hold.staff_id, customerId, hold.service_id, hold.starts_at, hold.ends_at, 'CONFIRMED', paymentStatus, paymentReference, now);
    if (paymentReference) db.prepare('UPDATE payments SET appointment_id = ? WHERE provider_reference = ?').run(id, paymentReference);
    db.prepare('DELETE FROM slot_holds WHERE id = ?').run(hold.id);
    db.prepare('INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,metadata,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(), customerId, 'APPOINTMENT_CONFIRMED', 'appointment', id, JSON.stringify({ paymentStatus }), now);
    return { id, salonId: hold.salon_id, staffId: hold.staff_id, serviceId: hold.service_id, startsAt: hold.starts_at, endsAt: hold.ends_at, price: service.price, paymentStatus };
  })();
}
function listForCustomer(customerId) {
  return db.prepare(`SELECT a.*, so.name AS salon_name, s.name AS service_name, s.price AS service_price, st.name AS staff_name FROM appointments a JOIN salons so ON so.id=a.salon_id JOIN services s ON s.id=a.service_id JOIN staff st ON st.id=a.staff_id WHERE a.customer_id = ? ORDER BY a.created_at DESC`).all(customerId);
}
function listForSalon(salonId) { return db.prepare(`SELECT a.*, so.name AS salon_name, s.name AS service_name, s.price AS service_price, st.name AS staff_name FROM appointments a JOIN salons so ON so.id=a.salon_id JOIN services s ON s.id=a.service_id JOIN staff st ON st.id=a.staff_id WHERE a.salon_id = ? ORDER BY a.created_at DESC`).all(salonId); }
module.exports = { status, hold, release, confirm, listForCustomer, listForSalon };
