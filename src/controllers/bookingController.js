const booking = require('../services/bookingService');
const payment = require('../services/paymentService');

function status(req, res) { res.json(booking.status(req.query, req.user.id)); }
function hold(req, res) { res.status(201).json(booking.hold(req.body, req.user.id)); }
function release(req, res) { res.json(booking.release(req.params.holdId, req.user.id)); }
function confirm(req, res) { res.status(201).json(booking.confirm(req.body, req.user.id)); }
function customerBookings(req, res) { res.json(booking.listForCustomer(req.user.id)); }
function salonBookings(req, res) { res.json(booking.listForSalon(req.user.salonId)); }
function createPaymentIntent(req, res) { res.status(201).json(payment.createIntent({ ...req.body, customerId: req.user.id })); }
function paymentWebhook(req, res) { res.json(payment.processWebhook((req.rawBody || Buffer.from(JSON.stringify(req.body))).toString('utf8'), req.get('x-payment-signature'))); }
module.exports = { status, hold, release, confirm, customerBookings, salonBookings, createPaymentIntent, paymentWebhook };
