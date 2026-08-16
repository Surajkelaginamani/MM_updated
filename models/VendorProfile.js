const mongoose = require('mongoose');

const vendorProfileSchema = new mongoose.Schema({
  // --- CORE IDENTITY ---
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ownerName: { type: String, required: true },
  businessName: { type: String, required: true },
  phone: { type: String, default: '' }, // Vendor contact number for tap-to-call
  
  // --- BUSINESS DETAILS ---
  serviceArea: { type: String, default: '' }, // e.g., "Sanjivani Hostels"
  serviceType: { type: String, default: 'Tiffin Service' },
  foodType: { type: String, enum: ['Veg', 'Non-Veg', 'Mix'], default: 'Mix' },
  deliveryType: { type: String, default: 'Delivery' },

  // --- 🚨 DEPRECATED: Fixed Pricing (kept for DB migration safety) 🚨 ---
  // monthlyFullPrice: { type: Number, default: 0 },
  // monthlyHalfPrice: { type: Number, default: 0 },
  // weeklyPrice: { type: Number, default: 0 },
  // singleMealPrice: { type: Number, default: 0 },

  // --- ✅ CUSTOM FLEXIBLE SUBSCRIPTION PLANS ---
  customPlans: [
    {
      planName:    { type: String, required: true, trim: true }, // e.g. "15 Days Lunch Only"
      durationDays:{ type: Number, required: true, min: 1 },     // e.g. 15
      mealsPerDay: { type: Number, required: true, enum: [1, 2] }, // 1 = half, 2 = full
      price:       { type: Number, required: true, min: 0 },     // e.g. 1800
      isActive:    { type: Boolean, default: true },             // ✅ Pause/unpause a plan without deleting it
    }
  ],

  // --- ✅ TRIAL TIFFIN PRICE ---
  // A one-off price for students to try a single tiffin before subscribing.
  // Set to 0 to hide the trial option from students.
  trialPrice: { type: Number, default: 0 },

  // --- 🚨 THE MASTER HOLIDAY POLICY TOGGLE 🚨 ---
  vendorConsidersHolidays: { type: Boolean, default: false },
  considersHolidays: { type: Boolean, default: false },

  // --- MENU & COMMUNICATION ---
  weeklyMenu: {
    type: Map,
    of: {
      lunch: { type: String, default: '' },
      dinner: { type: String, default: '' }
    },
    default: {}
  },

  // --- REVIEWS & RATING ---
  rating: { type: Number, default: 0 },
  totalReviews: { type: Number, default: 0 },

  // --- ADMIN APPROVAL STATUS ---
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending' 
  },
  approvalDate: { type: Date },
  rejectionReason: { type: String, default: '' }

}, { timestamps: true });

module.exports = mongoose.model('VendorProfile', vendorProfileSchema);