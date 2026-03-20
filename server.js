const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

// Serve Firebase config from environment variables
app.get('/api/firebase-config', (req, res) => {
  res.json({
    apiKey:            process.env.FIREBASE_API_KEY || '',
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId:         process.env.FIREBASE_PROJECT_ID || '',
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId:             process.env.FIREBASE_APP_ID || '',
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'kyc_portal.html'));
});

app.listen(PORT, () => {
  console.log(`ClearDue KYC Portal running on port ${PORT}`);
});
