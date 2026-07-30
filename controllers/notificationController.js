const User = require('../models/User'); // Loads your unified User model
const admin = require('firebase-admin');

// 1. Controller to save a phone's FCM Token to MongoDB
exports.updateFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    const userId = req.user.id; // Reads the logged-in user from your auth token/middleware

    if (!token) {
      return res.status(400).json({ message: 'Token is required' });
    }

    // Save the device token to this specific user's record
    await User.findByIdAndUpdate(userId, { fcmToken: token });
    return res.status(200).json({ message: 'FCM Token updated successfully.' });
  } catch (error) {
    return res.status(500).json({ message: 'Server error updating token.' });
  }
};

// 2. Reusable Helper function to send actual alerts
exports.sendPushNotification = async (targetFcmToken, title, body) => {
  if (!targetFcmToken) return; // If user has no device registered, skip safely

  const message = {
    notification: { title, body },
    token: targetFcmToken,
    android: {
      priority: 'high',
      notification: { sound: 'default' }
    }
  };

  try {
    await admin.messaging().send(message);
    console.log('Notification successfully pushed to device!');
  } catch (error) {
    console.error('Error delivering notification through FCM:', error);
  }
};