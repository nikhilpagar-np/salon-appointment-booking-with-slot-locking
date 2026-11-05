const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const authRoutes = require('./routes/auth');
const bookingRoutes = require('./routes/booking');
const { errorHandler } = require('./middleware/security');
const bookingController = require('./controllers/bookingController');
const { requireAuth, requireRole, asyncRoute } = require('./middleware/security');

const app = express();
app.use((req, res, next) => { req.id = crypto.randomUUID(); res.setHeader('X-Request-Id', req.id); next(); });
app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api', bookingRoutes);

// Backward-compatible paths for the existing UI. They remain authenticated and do not trust client identity/payment status.
app.get('/api/slots/status', requireAuth, asyncRoute((req, res) => bookingController.status(req, res)));
app.post('/api/locks', requireAuth, requireRole('CUSTOMER'), asyncRoute((req, res) => bookingController.hold(req, res)));
app.delete('/api/locks/:holdId', requireAuth, requireRole('CUSTOMER'), asyncRoute((req, res) => bookingController.release(req, res)));
app.post('/api/bookings', requireAuth, requireRole('CUSTOMER'), asyncRoute((req, res) => {
  req.body = { holdId: req.body.holdId || req.body.lockId, bookingId: req.body.bookingId, paymentMode: req.body.paymentMode || (req.body.payload?.pay === 'online' ? 'online' : 'at_salon'), paymentReference: req.body.paymentReference };
  return bookingController.confirm(req, res);
}));
app.get('/api/bookings', requireAuth, requireRole('CUSTOMER'), asyncRoute((req, res) => bookingController.customerBookings(req, res)));

app.use(express.static(path.join(__dirname, '..')));
app.use((_req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));
app.use(errorHandler);
module.exports = app;
