const mongoose = require('mongoose');

const vendorHolidaySchema = new mongoose.Schema({
  vendor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Your controller likely links this to the User's ID or VendorProfile
    required: true
  },
  dateKey: {
    type: String, // Format: YYYY-MM-DD
    required: true
  },
  reason: {
    type: String,
    default: 'Kitchen Closed'
  },
  extendedSubscriptionsCount: {
    type: Number,
    default: 0
  },
  time: { 
    type: String, 
    enum: ['morning', 'afternoon', 'full_day'],
    default: 'full_day'
  }
}, { timestamps: true });

// Ensure a vendor can't accidentally add two holidays on the exact same day
vendorHolidaySchema.index({ vendor: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model('VendorHoliday', vendorHolidaySchema);