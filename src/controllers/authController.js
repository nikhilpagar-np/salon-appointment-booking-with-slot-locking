const auth = require('../services/authService');
const env = require('../config/env');

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: env.nodeEnv === 'production', maxAge: env.sessionTtlMs, path: '/' };
}
function register(req, res) {
  const user = auth.register({ ...req.body, role: req.body.role === 'OWNER' ? 'OWNER' : 'CUSTOMER' });
  const session = auth.login(req.body.email, req.body.password);
  res.cookie('session', session.token, cookieOptions()).status(201).json({ user: auth.publicUser(user) });
}
function login(req, res) {
  const session = auth.login(req.body.email, req.body.password);
  res.cookie('session', session.token, cookieOptions()).json({ user: session.user });
}
function logout(req, res) {
  const cookies = require('../middleware/security').parseCookies(req.headers.cookie);
  auth.logout(cookies.session);
  res.clearCookie('session', { httpOnly: true, sameSite: 'lax', secure: env.nodeEnv === 'production', path: '/' }).status(204).end();
}
function me(req, res) { res.json({ user: req.user }); }
module.exports = { register, login, logout, me };
