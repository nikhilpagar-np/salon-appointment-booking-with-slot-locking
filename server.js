const express = require('express');
const Database = require('better-sqlite3');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const LOCK_DURATION_MS = Number(process.env.LOCK_DURATION_MS || 5 * 60 * 1000);
const CAPACITY = Number(process.env.SLOT_CAPACITY || 2);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bookings.db');
const fs = require('node:fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS slot_locks (
    id TEXT PRIMARY KEY,
    salon_id TEXT NOT NULL,
    booking_date TEXT NOT NULL,
    slot_time TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_slot_locks_slot
    ON slot_locks(salon_id, booking_date, slot_time, expires_at);
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    salon_id TEXT NOT NULL,
    booking_date TEXT NOT NULL,
    slot_time TEXT NOT NULL,
    user_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_slot
    ON bookings(salon_id, booking_date, slot_time);
  CREATE TRIGGER IF NOT EXISTS enforce_slot_capacity
  BEFORE INSERT ON bookings
  WHEN (SELECT COUNT(*) FROM bookings
        WHERE salon_id = NEW.salon_id
          AND booking_date = NEW.booking_date
          AND slot_time = NEW.slot_time) >= ${CAPACITY}
  BEGIN
    SELECT RAISE(ABORT, 'SLOT_FULL');
  END;
`);

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use((req, _res, next) => { cleanupExpiredLocks(); next(); });

function cleanupExpiredLocks(now = Date.now()) {
  db.prepare('DELETE FROM slot_locks WHERE expires_at <= ?').run(now);
}
function userId(req) { return String(req.get('x-user-id') || req.body?.userId || 'anonymous'); }
function requireFields(body, fields) {
  return fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === '');
}
function slotParams(body) {
  return { salonId: String(body.salonId), date: String(body.date), time: String(body.time) };
}
function counts(salonId, date, time, now = Date.now()) {
  const confirmed = db.prepare(`SELECT COUNT(*) AS count FROM bookings
    WHERE salon_id = ? AND booking_date = ? AND slot_time = ?`).get(salonId, date, time).count;
  const reserved = db.prepare(`SELECT COUNT(*) AS count FROM slot_locks
    WHERE salon_id = ? AND booking_date = ? AND slot_time = ? AND expires_at > ?`).get(salonId, date, time, now).count;
  return { confirmed, reserved, capacity: CAPACITY, available: Math.max(0, CAPACITY - confirmed - reserved) };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/slots/status', (req, res) => {
  const missing = requireFields(req.query, ['salonId', 'date', 'time']);
  if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
  cleanupExpiredLocks();
  res.json(counts(String(req.query.salonId), String(req.query.date), String(req.query.time)));
});

app.post('/api/locks', (req, res) => {
  const missing = requireFields(req.body, ['salonId', 'date', 'time']);
  if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
  const { salonId, date, time } = slotParams(req.body);
  const uid = userId(req);
  const now = Date.now();
  const lockId = `lk_${crypto.randomUUID()}`;
  const tx = db.transaction(() => {
    cleanupExpiredLocks(now);
    const current = counts(salonId, date, time, now);
    if (current.available <= 0) {
      const error = new Error('SLOT_UNAVAILABLE'); error.current = current; throw error;
    }
    db.prepare(`INSERT INTO slot_locks
      (id, salon_id, booking_date, slot_time, user_id, user_name, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      lockId, salonId, date, time, uid, req.body.userName || null, now + LOCK_DURATION_MS, now
    );
    return { lockId, expiresAt: now + LOCK_DURATION_MS, ...counts(salonId, date, time, now) };
  });
  try { return res.status(201).json(tx()); }
  catch (error) {
    if (error.message === 'SLOT_UNAVAILABLE') return res.status(409).json({ error: 'SLOT_UNAVAILABLE', ...error.current });
    console.error(error); return res.status(500).json({ error: 'Unable to lock slot' });
  }
});

app.delete('/api/locks/:lockId', (req, res) => {
  const result = db.prepare('DELETE FROM slot_locks WHERE id = ? AND user_id = ?').run(req.params.lockId, userId(req));
  res.json({ released: result.changes > 0 });
});

app.post('/api/bookings', (req, res) => {
  const missing = requireFields(req.body, ['salonId', 'date', 'time', 'bookingId', 'payload']);
  if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
  const { salonId, date, time } = slotParams(req.body);
  const uid = userId(req);
  const paymentStatus = req.body.paymentStatus || 'paid';
  const now = Date.now();
  try {
    const result = db.transaction(() => {
      cleanupExpiredLocks(now);
      const lock = db.prepare(`SELECT * FROM slot_locks WHERE id = ? AND user_id = ?
        AND expires_at > ?`).get(req.body.lockId, uid, now);
      if (!lock) { const error = new Error('LOCK_INVALID'); throw error; }
      if (paymentStatus === 'failed') {
        db.prepare('DELETE FROM slot_locks WHERE id = ?').run(lock.id);
        return { released: true, booking: null };
      }
      const payload = JSON.stringify(req.body.payload);
      db.prepare(`INSERT INTO bookings
        (id, salon_id, booking_date, slot_time, user_id, payload, payment_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(req.body.bookingId), salonId, date, time, uid, payload, paymentStatus, now
      );
      db.prepare('DELETE FROM slot_locks WHERE id = ?').run(lock.id);
      return { released: true, booking: req.body.payload };
    })();
    res.status(paymentStatus === 'failed' ? 402 : 201).json(result);
  } catch (error) {
    if (error.message === 'LOCK_INVALID') return res.status(409).json({ error: 'LOCK_INVALID', message: 'The slot lock expired or belongs to another customer.' });
    if (String(error.message).includes('SLOT_FULL') || String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'SLOT_FULL' });
    console.error(error); res.status(500).json({ error: 'Unable to confirm booking' });
  }
});

app.get('/api/bookings', (req, res) => {
  const uid = userId(req);
  const rows = db.prepare('SELECT payload FROM bookings WHERE user_id = ? ORDER BY created_at DESC').all(uid);
  res.json(rows.map((row) => JSON.parse(row.payload)));
});

app.use(express.static(__dirname));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

if (require.main === module) app.listen(PORT, () => console.log(`Salon booking server running at http://localhost:${PORT}`));
module.exports = { app, db, cleanupExpiredLocks };
