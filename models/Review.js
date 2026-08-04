const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProfile', required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Backward/forward compatibility for legacy fields & indexes
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorProfile' },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: '' },
  text: { type: String, default: '' }
}, { timestamps: true });

// Prevent a student from leaving multiple reviews for the same kitchen
reviewSchema.index({ vendor: 1, customer: 1 }, { unique: true });

const Review = mongoose.model('Review', reviewSchema);

// Programmatically drop legacy index vendorId_1_customerId_1 if present in MongoDB
Review.syncIndexes().then(async () => {
  try {
    await Review.collection.dropIndex('vendorId_1_customerId_1');
    console.log('[MongoDB] Successfully dropped legacy index vendorId_1_customerId_1');
  } catch (err) {
    // Index did not exist or already dropped, ignore error
  }
}).catch(() => {});

module.exports = Review;