const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const env = require('../config/env');

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const migrationDir = path.join(__dirname, 'migrations');
  for (const file of fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
    const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(file);
    if (!applied) {
      db.transaction(() => {
        db.exec(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(file, Date.now());
      })();
    }
  }
  seedDefaults();
}

function seedDefaults() {
  const now = Date.now();
  const salon = db.prepare('SELECT id FROM salons LIMIT 1').get();
  const salonId = salon?.id || 'salon-demo';
  if (!salon) db.prepare('INSERT INTO salons(id,name,timezone,created_at) VALUES (?,?,?,?)').run(salonId, 'Infinity Salon', 'Asia/Kolkata', now);
  let staff = db.prepare('SELECT id FROM staff WHERE salon_id = ? LIMIT 1').get(salonId);
  if (!staff) {
    staff = { id: 'staff-demo', name: 'Demo Stylist' };
    db.prepare('INSERT INTO staff(id,salon_id,name,created_at) VALUES (?,?,?,?)').run(staff.id, salonId, staff.name, now);
    for (let weekday = 0; weekday < 7; weekday += 1) db.prepare('INSERT INTO staff_schedules(id,staff_id,weekday,start_minute,end_minute) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), staff.id, weekday, 600, 1200);
  }
  let service = db.prepare('SELECT id FROM services WHERE salon_id = ? LIMIT 1').get(salonId);
  if (!service) {
    service = { id: 'service-demo', name: 'Classic Haircut', price: 500, duration: 30 };
    db.prepare('INSERT INTO services(id,salon_id,name,price,duration_minutes) VALUES (?,?,?,?,?)').run(service.id, salonId, service.name, service.price, service.duration);
    db.prepare('INSERT OR IGNORE INTO staff_services(staff_id,service_id) VALUES (?,?)').run(staff.id, service.id);
  }
}

migrate();
module.exports = { db, migrate };
