const express = require('express');
const controller = require('../controllers/authController');
const { requireAuth, asyncRoute } = require('../middleware/security');
const router = express.Router();
router.post('/register', asyncRoute(controller.register));
router.post('/login', asyncRoute(controller.login));
router.post('/logout', asyncRoute(controller.logout));
router.get('/me', requireAuth, asyncRoute(controller.me));
module.exports = router;
