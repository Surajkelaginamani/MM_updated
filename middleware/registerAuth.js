const admin = require('firebase-admin');

const verifyRegistrationToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Just verify they are a real Firebase user
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Attach ONLY the Firebase info to the request
    req.firebaseUser = {
      uid: decodedToken.uid,
      email: decodedToken.email
    };

    next(); 
  } catch (error) {
    console.error('Firebase Registration Auth Error:', error.message);
    return res.status(403).json({ message: 'Unauthorized: Invalid Firebase token' });
  }
};

module.exports = verifyRegistrationToken;