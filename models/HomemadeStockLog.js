const mongoose = require('mongoose');

const homemadeStockLogSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProfile', required: true },
    item: { type: mongoose.Schema.Types.ObjectId, ref: 'HomemadeItem', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'HomemadeOrder' },
    action: { 
      type: String, 
      enum: ['item_created', 'order_placed', 'restock', 'order_cancelled_restore'], 
      required: true 
    },
    quantityChange: { type: Number, required: true },
    previousStock: { type: Number, required: true },
    newStock: { type: Number, required: true },
    note: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('HomemadeStockLog', homemadeStockLogSchema);