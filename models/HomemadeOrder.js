const mongoose = require('mongoose');

const homemadeOrderSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProfile', required: true },
    item: { type: mongoose.Schema.Types.ObjectId, ref: 'HomemadeItem', required: true },
    itemName: { type: String, required: true },
    itemUnit: { type: String, default: 'per unit' },
    pricePerUnit: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    totalAmount: { type: Number, required: true, min: 0 },
    status: { 
      type: String, 
      enum: ['placed', 'confirmed', 'delivered', 'cancelled'], 
      default: 'placed' 
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('HomemadeOrder', homemadeOrderSchema);