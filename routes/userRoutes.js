const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const verifyToken = require('../middleware/authMiddleware');

// Existing: POST /api/users/update-token (keep for backward compat)
router.post('/update-token', verifyToken, notificationController.updateFcmToken);

// Required: PUT /api/users/update-fcm-token (used by the Flutter app)
router.put('/update-fcm-token', verifyToken, notificationController.updateFcmToken);

module.exports = router;