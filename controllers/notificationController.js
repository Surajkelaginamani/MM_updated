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