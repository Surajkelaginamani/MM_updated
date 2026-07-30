const admin = require('firebase-admin');
const fs = require('fs');

let serviceAccount;

try {
  // 1. Try Render Secret File path first
  if (fs.existsSync('/etc/secrets/firebase-adminsdk.json')) {
    const rawData = fs.readFileSync('/etc/secrets/firebase-adminsdk.json', 'utf8');
    serviceAccount = JSON.parse(rawData);
    console.log('🔑 Loaded Firebase service account from /etc/secrets/firebase-adminsdk.json');
  } 
  // 2. Fallback to local development path
  else if (fs.existsSync('./firebase-adminsdk.json')) {
    const rawData = fs.readFileSync('./firebase-adminsdk.json', 'utf8');
    serviceAccount = JSON.parse(rawData);
    console.log('🔑 Loaded Firebase service account from ./firebase-adminsdk.json');
  } else if (fs.existsSync('./serviceAccountKey.json')) {
    const rawData = fs.readFileSync('./serviceAccountKey.json', 'utf8');
    serviceAccount = JSON.parse(rawData);
    console.log('🔑 Loaded Firebase service account from ./serviceAccountKey.json');
  } else {
    throw new Error('No firebase-adminsdk.json file found at /etc/secrets/ or ./');
  }

  // 🚨 CRITICAL FIX FOR RENDER: Sanitize double-escaped newlines in private key
  if (serviceAccount && serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  // Initialize Firebase Admin safely (avoid duplicate app errors)
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin SDK initialized successfully!');
  }
} catch (error) {
  console.error('❌ Firebase Admin SDK initialization failed:', error.message);
}

module.exports = admin;
