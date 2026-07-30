const mongoose = require('mongoose');

const dailyMenuSchema = new mongoose.Schema({
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProfile', required: true },
  
  // The specific date this menu is for
  date: { type: Date, required: true },
  
  // Matching your UI boxes for Lunch and Dinner
  lunch: {
    items: { type: String, required: true },
    time: { type: String, default: "12:30 PM" }
  },
  dinner: {
    items: { type: String }, // Optional, in case they only serve lunch
    time: { type: String, default: "8:00 PM" }
  }
}, { timestamps: true });

// Ensures a vendor can't accidentally create two different menus for the exact same day
dailyMenuSchema.index({ vendor: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyMenu', dailyMenuSchema);