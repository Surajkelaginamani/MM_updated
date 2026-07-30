const admin = require('firebase-admin');
const User = require('../models/User');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // 💡 DEVELOPMENT CHEAT CODE: If token is "dev-test", bypass Firebase validation
    if (token === 'dev-test' && process.env.NODE_ENV !== 'production') {
      // Find ANY user in your local MongoDB to simulate being logged in
      const mockUser = await User.findOne(); 
      if (!mockUser) {
        return res.status(404).json({ message: 'Dev Mode: Please create at least one user in MongoDB first.' });
      }
      
      req.user = {
        userId: mockUser._id,
        firebaseUid: mockUser.firebaseUid,
        role: mockUser.role,
        isSuperAdmin: mockUser.isSuperAdmin ?? false,
      };
      return next();
    }

    // --- Original Firebase Verification Logic ---
    const decodedToken = await admin.auth().verifyIdToken(token);
    const user = await User.findOne({ firebaseUid: decodedToken.uid });
    
    if (!user) {
      console.error('❌ User not found in MongoDB:', { uid: decodedToken.uid, email: decodedToken.email });
      if (decodedToken.email && decodedToken.email.toLowerCase() === 'admin@mealmitra.com') {
        req.user = {
          userId: decodedToken.uid,
          firebaseUid: decodedToken.uid,
          role: 'admin'
        };
        return next();
      }

      return res.status(404).json({ message: 'User profile not found in database. Please complete registration.' });
    }

    console.log('✅ Token verified for user:', user._id);
    req.user = {
      userId: user._id,
      firebaseUid: user.firebaseUid,
      role: user.role,
      isSuperAdmin: user.isSuperAdmin ?? false,
    };

    next();
  } catch (error) {
    console.error('Firebase Auth Error:', error.message);
    return res.status(403).json({ message: 'Unauthorized: Invalid or expired token' });
  }
};

module.exports = verifyToken;
