    const mongoose = require('mongoose');

const homemadeItemSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProfile', required: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, trim: true, default: 'Other' },
    price: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true, default: 'per unit' },
    description: { type: String, trim: true, default: '' },
    imageUrl: { type: String, trim: true, default: '' },
    stockQuantity: { type: Number, required: true, min: 0, default: 0 },
    inStock: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('HomemadeItem', homemadeItemSchema);