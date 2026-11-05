const { getUserByToken } = require('../services/authService');

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key, value]) => key && value));
}
function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const user = getUserByToken(cookies.session);
  if (!user) return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
  req.user = user;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'FORBIDDEN' });
    next();
  };
}
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function errorHandler(error, _req, res, _next) {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error(JSON.stringify({ level: 'error', message: error.message, stack: error.stack }));
  res.status(status).json({ error: status >= 500 ? 'INTERNAL_SERVER_ERROR' : error.message });
}
module.exports = { requireAuth, requireRole, asyncRoute, errorHandler, parseCookies };
