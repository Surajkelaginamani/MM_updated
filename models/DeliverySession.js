const mongoose = require('mongoose');

const deliverySessionSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VendorProfile',
      required: true
    },
    date: {
      type: String, // YYYY-MM-DD format
      required: true
    },
    currentSession: {
      type: String,
      enum: ['morning', 'afternoon', 'completed'],
      default: 'morning'
    },
    morningDeliveries: {
      totalCount: { type: Number, default: 0 },
      locationWise: { type: mongoose.Schema.Types.Mixed, default: {} }
    },
    afternoonDeliveries: {
      totalCount: { type: Number, default: 0 },
      locationWise: { type: mongoose.Schema.Types.Mixed, default: {} }
    },
    lastUpdated: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

deliverySessionSchema.index({ vendor: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DeliverySession', deliverySessionSchema);









