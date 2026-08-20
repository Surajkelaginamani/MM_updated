const User = require('../models/User'); // Loads your unified User model
const admin = require('firebase-admin');

// 1. Controller to save a phone's FCM Token to MongoDB
exports.updateFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    // authMiddleware sets req.user.userId — support all variants defensively
    const userId = req.user.userId || req.user.id || req.user._id;

    if (!token) {
      return res.status(400).json({ message: 'Token is required' });
    }
    if (!userId) {
      console.error('❌ updateFcmToken: could not resolve userId from req.user:', req.user);
      return res.status(400).json({ message: 'User identity could not be determined.' });
    }

    // Save the device token to this specific user's record
    const updated = await User.findByIdAndUpdate(userId, { fcmToken: token }, { new: true });
    if (!updated) {
      console.error('❌ updateFcmToken: No user found for id:', userId);
      return res.status(404).json({ message: 'User not found.' });
    }

    console.log(`✅ FCM Token saved for user: ${userId}`);
    return res.status(200).json({ message: 'FCM Token updated successfully.' });
  } catch (error) {
    console.error('❌ Error updating FCM token:', error);
    return res.status(500).json({ message: 'Server error updating token.' });
  }
};

// 1b. Clear the FCM token on logout — prevents notifications reaching signed-out users
exports.clearFcmToken = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id || req.user._id;
    if (!userId) {
      return res.status(400).json({ message: 'User identity could not be determined.' });
    }

    await User.findByIdAndUpdate(userId, { fcmToken: null });
    console.log(`🔕 FCM Token cleared for user: ${userId}`);
    return res.status(200).json({ message: 'FCM Token cleared successfully.' });
  } catch (error) {
    console.error('❌ Error clearing FCM token:', error);
    return res.status(500).json({ message: 'Server error clearing token.' });
  }
};

// 2. Reusable Helper function to send actual alerts
// `type` is included in the FCM `data` payload so the Flutter app can
// navigate to the correct screen when the user taps the notification.
exports.sendPushNotification = async (targetFcmToken, title, body, type = 'general') => {
  if (!targetFcmToken) return; // If user has no device registered, skip safely

  const message = {
    notification: { title, body },
    data: { type },           // ← routing hint read by NotificationRouter in Flutter
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