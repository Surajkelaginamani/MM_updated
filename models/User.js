const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Links the MongoDB user to their secure Firebase Auth account
  firebaseUid: { 
    type: String, 
    required: true, 
    unique: true 
  },
  name: { 
    type: String, 
    required: true 
  },
  email: { 
    type: String, 
    required: true, 
    unique: true 
  },
  phone: { 
    type: String 
  },
  role: { 
    type: String, 
    enum: ['vendor', 'customer', 'student', 'admin'],
    default: 'student' 
  },
  // Super Admin flag — only set manually or via the create-admin route.
  // A super admin is still role:'admin'; this flag grants elevated privileges.
  isSuperAdmin: {
    type: Boolean,
    default: false,
  },
  // Student-specific fields (Vendors will leave these blank)
  location: { 
    type: String // e.g., Hostel Name or Address
  },
  roomNumber: { 
    type: String 
  },
  fcmToken: {
    type: String,
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);