const User = require('../models/User');
const VendorProfile = require('../models/VendorProfile');
const Subscription = require('../models/Subscription');
const admin = require('firebase-admin');
// POST /api/admin/register
exports.registerAdmin = async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ message: 'Email, password, and name are required.' });
    }

    // 1. Create account in Firebase Auth
    const firebaseUser = await admin.auth().createUser({
      email,
      password,
      displayName: name,
    });

    // 2. Save user profile in MongoDB using your User schema
    const newAdmin = await User.create({
      firebaseUid: firebaseUser.uid,
      name,
      email,
      phone,
      role: 'admin' // Explicitly set role to admin
    });

    // 3. Generate verification link via Firebase
    const verificationLink = await admin.auth().generateEmailVerificationLink(email);

    res.status(201).json({
      message: 'Admin account created successfully! Verification email generated.',
      admin: newAdmin,
      verificationLink // Optional: returns link directly in Postman response for easy testing
    });
  } catch (error) {
    console.error('Error registering admin:', error);
    res.status(500).json({ message: error.message || 'Server error creating admin.' });
  }
};
// GET /api/admin/dashboard
exports.getAdminDashboard = async (req, res) => {
  try {
    const lockedVendorFilter = {
      $or: [
        { status: { $exists: false } },
        { status: null },
        { status: '' },
        { status: { $ne: 'approved' } }
      ]
    };

    // 1. Get Platform Stats
    const totalStudents = await User.countDocuments({ role: 'student' });
    const totalVendors = await VendorProfile.countDocuments({ status: 'approved' });
    const activeSubscriptions = await Subscription.countDocuments({ status: 'active' });

    // 2. Count every kitchen that cannot log in yet.
    const pendingVendorsCount = await VendorProfile.countDocuments(lockedVendorFilter);

    // 3. Fetch the actual list of locked vendors for the approval cards
    const pendingVendors = await VendorProfile.find(lockedVendorFilter)
      .select('businessName ownerName phone serviceArea status createdAt')
      .sort({ createdAt: -1 });

    res.status(200).json({
      stats: {
        totalStudents,
        totalVendors,
        pendingVendors: pendingVendorsCount,
        activeSubscriptions,
        // Surface the super-admin flag so Flutter can gate the UI
        // without making a separate profile API call.
        isSuperAdmin: req.user?.isSuperAdmin ?? false,
      },
      pendingApprovals: pendingVendors
    });
  } catch (error) {
    console.error("Admin Dashboard Error:", error);
    res.status(500).json({ message: 'Server error fetching admin data.' });
  }
};
exports.getAllVendors = async (req, res) => {
  try {
    // Ensure you are NOT selecting just a few fields. 
    // Fetch the full document to include ownerName, serviceArea, etc.
    const vendors = await VendorProfile.find({ status: 'approved' }); 
    res.status(200).json(vendors);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching vendors' });
  }
};
// Get all Students
exports.getAllStudents = async (req, res) => {
  try {
    const students = await User.find({ role: 'customer' }).select('-password -__v');
    res.status(200).json(students);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching students' });
  }
};
// POST /api/admin/create-admin  (Super Admin only — guarded by requireSuperAdmin middleware)
exports.createAdmin = async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    // --- Input validation ---
    if (!email || !password || !name) {
      return res.status(400).json({ message: 'Name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    // --- Check for duplicate email in MongoDB before touching Firebase ---
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    // 1. Create the user in Firebase Auth
    const firebaseUser = await admin.auth().createUser({
      email,
      password,
      displayName: name,
      emailVerified: false,
    });

    // 2. Save the user profile in MongoDB with role:'admin', isSuperAdmin:false
    const newAdmin = await User.create({
      firebaseUid: firebaseUser.uid,
      name,
      email: email.toLowerCase(),
      phone: phone || '',
      role: 'admin',
      isSuperAdmin: false, // Only manually promoted via DB — never through this route
    });

    res.status(201).json({
      message: `Admin account for "${name}" created successfully!`,
      admin: {
        _id: newAdmin._id,
        name: newAdmin.name,
        email: newAdmin.email,
        phone: newAdmin.phone,
        role: newAdmin.role,
        isSuperAdmin: newAdmin.isSuperAdmin,
      },
    });
  } catch (error) {
    console.error('Error creating admin:', error);
    // Surface a clean Firebase error message when the email is already in Firebase
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ message: 'This email is already registered in Firebase Auth.' });
    }
    res.status(500).json({ message: error.message || 'Server error creating admin account.' });
  }
};

// POST /api/admin/vendor/status
exports.updateVendorStatus = async (req, res) => {
  try {
    const { vendorId, status } = req.body; // status should be 'approved' or 'rejected'

    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid vendor status.' });
    }

    const update = {
      status,
      approvalDate: status === 'approved' ? new Date() : null
    };

    // Update the vendor's status in the database
    const updatedVendor = await VendorProfile.findByIdAndUpdate(
      vendorId,
      update,
      { new: true, runValidators: true }
    );

    if (!updatedVendor) {
      return res.status(404).json({ message: 'Vendor not found.' });
    }

    res.status(200).json({ 
      message: `Kitchen successfully ${status}!`, 
      vendor: updatedVendor 
    });
  } catch (error) {
    console.error("Error updating vendor status:", error);
    res.status(500).json({ message: 'Server error updating status.' });
  }
};
