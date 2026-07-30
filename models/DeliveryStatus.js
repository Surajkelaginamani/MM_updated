const mongoose = require('mongoose');

const deliveryStatusSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VendorProfile',
      required: true
    },
    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      required: true
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    dateKey: {
      type: String,
      required: true
    },
    session: {
      type: String,
      enum: ['morning', 'afternoon'],
      default: 'afternoon'
    },
    deliveredAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

deliveryStatusSchema.index({ vendor: 1, subscription: 1, dateKey: 1, session: 1 }, { unique: true });

module.exports = mongoose.model('DeliveryStatus', deliveryStatusSchema);