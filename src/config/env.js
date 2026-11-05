const path = require('node:path');

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: number('PORT', 3000),
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'bookings.db'),
  sessionTtlMs: number('SESSION_TTL_MS', 7 * 24 * 60 * 60 * 1000),
  lockDurationMs: number('LOCK_DURATION_MS', 5 * 60 * 1000),
  allowDemoPayment: process.env.ALLOW_DEMO_PAYMENT === 'true',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@example.com',
  adminPassword: process.env.ADMIN_PASSWORD || 'change-this-in-production'
};
