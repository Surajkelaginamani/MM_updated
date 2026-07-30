require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
// --- FIREBASE ADMIN SETUP ---
const admin = require('./config/firebase');

// --- EXPRESS APP SETUP ---
const app = express();
app.use(cors());
app.use(express.json()); // Allows us to read JSON data from the Flutter app

// --- DATABASE CONNECTION ---
// Make sure to create a .env file with your MONGO_URI string.
console.log('Connecting to MongoDB:', process.env.MONGO_URI ? 'configured' : 'missing MONGO_URI');

mongoose.connect(process.env.MONGO_URI, {
  // Removed the deprecated useNewUrlParser and useUnifiedTopology!
  tls: true,                            
  tlsAllowInvalidCertificates: false,   
  serverSelectionTimeoutMS: 10000        
})   
  .then(async () => {
    console.log('✅ MongoDB Connected Successfully');
    try {
      const VendorProfile = require('./models/VendorProfile');
      const User = require('./models/User');
      const unpopulated = await VendorProfile.find({
        $or: [{ phone: '' }, { phone: { $exists: false } }]
      });
      for (const vp of unpopulated) {
        if (vp.vendorId) {
          const user = await User.findById(vp.vendorId);
          if (user && user.phone) {
            vp.phone = user.phone;
            await vp.save();
            console.log(`✅ Backfilled phone ${user.phone} for VendorProfile ${vp._id} (${vp.businessName})`);
          }
        }
      }
    } catch (backfillErr) {
      console.error('❌ Vendor phone backfill error:', backfillErr);
    }
  })
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err);
    console.error('🔎 Verify your Atlas connection string, IP whitelist, and TLS settings.');
  });

// --- API ROUTES GO HERE ---
const vendorRoutes = require('./routes/vendorRoutes');
const customerRoutes = require('./routes/customerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const userRoutes = require('./routes/userRoutes');

app.use('/api/vendor', vendorRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
// This tells Express: "If a request starts with /api/vendor, send it to vendorRoutes!"


app.get('/', (req, res) => {
  res.send('MealMitra API is running strong!');
});

// --- START SERVER ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});

