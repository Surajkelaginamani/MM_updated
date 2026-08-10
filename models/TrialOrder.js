const mongoose = require('mongoose');

const trialOrderSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VendorProfile',
      required: true,
    },
    // 'YYYY-MM-DD' — the IST date the student wants the trial delivered
    targetDate: { type: String, required: true },
    // 'morning' (Lunch ~12:30 PM) or 'afternoon' (Dinner ~8:00 PM)
    targetSession: {
      type: String,
      enum: ['morning', 'afternoon'],
      required: true,
    },
    price: { type: Number, default: 0 },
    // Vendor moves from pending → accepted or declined
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TrialOrder', trialOrderSchema);
