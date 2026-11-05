const crypto = require('node:crypto');
const { db } = require('../database/db');
const env = require('../config/env');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString('hex')}`;
}
function verifyPassword(password, encoded) {
  const [, n, r, p, salt, expected] = String(encoded).split('$');
  if (!n || !r || !p || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64, { N: Number(n), r: Number(r), p: Number(p) }).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function publicUser(user) { return { id: user.id, email: user.email, name: user.name, role: user.role, salonId: user.salon_id, staffId: user.staff_id }; }
function validateCredentials(email, password) {
  if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) throw Object.assign(new Error('Valid email is required'), { status: 400 });
  if (typeof password !== 'string' || password.length < 10) throw Object.assign(new Error('Password must be at least 10 characters'), { status: 400 });
}
function register({ email, password, name, role = 'CUSTOMER', salonId = null }) {
  validateCredentials(email, password);
  if (!name || String(name).trim().length < 2) throw Object.assign(new Error('Name is required'), { status: 400 });
  if (!['CUSTOMER', 'OWNER'].includes(role)) throw Object.assign(new Error('Invalid registration role'), { status: 400 });
  const id = crypto.randomUUID();
  try {
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,salon_id,created_at) VALUES (?,?,?,?,?,?,?)').run(id, email.toLowerCase(), name.trim(), hashPassword(password), role, salonId, Date.now());
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw Object.assign(new Error('Email is already registered'), { status: 409 });
    throw error;
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function login(email, password) {
  validateCredentials(email, password);
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) throw Object.assign(new Error('Invalid email or password'), { status: 401 });
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(tokenHash(token), user.id, Date.now() + env.sessionTtlMs, Date.now());
  return { token, user: publicUser(user) };
}
function logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)); }
function getUserByToken(token) {
  if (!token) return null;
  const user = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash(token), Date.now());
  if (!user) return null;
  return publicUser(user);
}
function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(env.adminEmail);
  if (!existing && env.nodeEnv !== 'test') db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), env.adminEmail, 'Platform Admin', hashPassword(env.adminPassword), 'ADMIN', Date.now());
}
seedAdmin();
module.exports = { register, login, logout, getUserByToken, publicUser, seedAdmin };
