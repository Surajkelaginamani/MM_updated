const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProfile', required: true },
  
  // 🚨 THE CALENDAR ENGINE 🚨
  planType: { type: String, required: true }, // e.g., 'monthly_full', '15_days'
  mealType: { type: String, required: true },
  preferredSession: { type: String, enum: ['morning', 'afternoon', 'both'], default: 'both' },
  startDate: { type: Date, required: false },
  endDate: { type: Date, required: false }, // This will shift dynamically!
  
  // 🚨 THE TWO-TIER HOLIDAY TRACKER 🚨
  vendorConsidersHolidays: { type: Boolean, required: true, default: false }, 
  skippedDates: [{
    date: String, // e.g., '2026-06-25'
    time: { type: String, enum: ['morning', 'afternoon', 'full_day'], default: 'full_day' },
    isConsideredForExtension: { type: Boolean, default: false } // The magic UI boolean
  }],
  
  // 🚨 THE POSTPAID LEDGER 🚨
  totalBill: { type: Number, required: true, default: 0 },
  status: { type: String, enum: ['pending', 'active', 'cancelled'], default: 'pending' },
  paymentStatus: { 
    type: String, 
    enum: ['unpaid', 'partial', 'paid'], 
    default: 'unpaid' 
  },
  lastReminderSentAt: { type: Date }, // For the 5-day nagging loop
  amountPaid: { 
    type: Number, 
    default: 0 
  },
 vendorExtensionDays: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Subscription', subscriptionSchema);
