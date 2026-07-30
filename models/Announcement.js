const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
  type: { type: String, required: true }, // 'General', 'Menu Update', 'Poll', etc.
  text: { type: String, required: true },
  
  // 🚨 NEW: Added options for the Poll feature
  options: [{
    text: { type: String },
    votes: { type: Number, default: 0 },
    // We store the student IDs here so they can't vote twice!
    voters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] 
  }],
  
  isClosed: { type: Boolean, default: false }, // 🔒 Vendor can lock the poll to prevent further votes
  createdAt: { type: Date, default: Date.now, expires: 86400 } // Auto-deletes after 24 hours
});

module.exports = mongoose.model('Announcement', announcementSchema);