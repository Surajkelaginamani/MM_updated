require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const VendorProfile = require('./models/VendorProfile');
const DailyMenu = require('./models/DailyMenu');

const seedDatabase = async () => {
  try {
    console.log('⏳ Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected!');

    // 1. Clear out old test data
    await User.deleteMany({});
    await VendorProfile.deleteMany({});
    await DailyMenu.deleteMany({});
    console.log('🧹 Cleaned up old data.');

    // 2. Create a Mock User
    const mockUser = await User.create({
      firebaseUid: 't4l2IHhJGLZKY6qPVetXl5xlSdE3',
      name: 'Sakshi Test Vendor',
      email: 'vendor@mealmitra.com',
      phone: '9876543210',
      role: 'vendor'
    });
    console.log('👤 Created Mock User.');

    // 3. Create a Mock Vendor Profile linked to that user
    const mockProfile = await VendorProfile.create({
      vendorId: mockUser._id,
      businessName: 'Tiffin Squad Kitchen',
      ownerName: 'Sakshi',
      serviceArea: 'SCSMCOE Campus',
      foodType: 'Mix',
      status: 'approved',
      monthlyFee: 3000,
      singleTiffinPrice: 120,
      weeklyMenu: {
        Monday: { lunch: 'Paneer Masala, 4 Roti, Rice', dinner: 'Dal Tadka, Rice' },
        Tuesday: { lunch: 'Aloo Gobi, 4 Roti', dinner: 'Khichdi' },
        Wednesday: { lunch: 'Chole Bhature', dinner: 'Palak Paneer, 3 Roti' },
        Thursday: { lunch: 'Rajma Chawal', dinner: 'Mix Veg, 4 Roti' },
        Friday: { lunch: 'Veg Biryani, Raita', dinner: 'Dal Fry, Rice' },
        Saturday: { lunch: 'Puri Bhaji', dinner: 'Pav Bhaji' },
        Sunday: { lunch: 'Special Thali', dinner: 'Closed' }
      }
    });
    console.log('🍳 Created Mock Vendor Profile.');

    console.log('🎉 Database successfully seeded! You can now test your APIs.');
    process.exit();
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
};

seedDatabase();