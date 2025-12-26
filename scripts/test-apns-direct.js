/**
 * Direct APNs test - bypasses the apn library entirely
 * Run: APNS_KEY_PATH=./AuthKey.p8 node scripts/test-apns-direct.js <device_token> [sandbox|production]
 */

const http2 = require('http2');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const APNS_KEY_PATH = process.env.APNS_KEY_PATH || '/app/secrets/AuthKey_62RJ26H8X3.p8';
const APNS_KEY_ID = process.env.APNS_KEY_ID || '62RJ26H8X3';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '9626BEV4Z4';
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.yapt.Yapt';
const DEVICE_TOKEN = process.argv[2];
const ENV = process.argv[3] || 'sandbox';

if (!DEVICE_TOKEN) {
  console.error('Usage: node scripts/test-apns-direct.js <device_token> [sandbox|production]');
  process.exit(1);
}

const APNS_HOST = ENV === 'production'
  ? 'api.push.apple.com'
  : 'api.sandbox.push.apple.com';

console.log('=== APNs Direct Test ===');
console.log('Host:', APNS_HOST);
console.log('Environment:', ENV);
console.log('Bundle ID:', APNS_BUNDLE_ID);
console.log('Team ID:', APNS_TEAM_ID);
console.log('Key ID:', APNS_KEY_ID);
console.log('Key Path:', APNS_KEY_PATH);
console.log('Token (last 8):', DEVICE_TOKEN.slice(-8));
console.log('');

// Read key
const key = fs.readFileSync(APNS_KEY_PATH);
console.log('Key file read successfully, length:', key.length);

// Generate JWT using jsonwebtoken library
const jwtToken = jwt.sign(
  {
    iss: APNS_TEAM_ID,
    iat: Math.floor(Date.now() / 1000),
  },
  key,
  {
    algorithm: 'ES256',
    keyid: APNS_KEY_ID,
  }
);

console.log('JWT generated successfully');
console.log('JWT preview:', jwtToken.substring(0, 50) + '...');
console.log('');

// Create notification payload
const payload = JSON.stringify({
  aps: {
    alert: {
      title: 'Test Notification',
      body: 'Direct APNs test from script',
    },
    sound: 'default',
  },
});

// Connect via HTTP/2
console.log('Connecting to', APNS_HOST, '...');
const client = http2.connect(`https://${APNS_HOST}`);

client.on('error', (err) => {
  console.error('Connection error:', err);
  process.exit(1);
});

client.on('connect', () => {
  console.log('Connected!');
});

const req = client.request({
  ':method': 'POST',
  ':path': `/3/device/${DEVICE_TOKEN}`,
  'authorization': `bearer ${jwtToken}`,
  'apns-topic': APNS_BUNDLE_ID,
  'apns-push-type': 'alert',
  'apns-priority': '10',
  'content-type': 'application/json',
});

req.on('response', (headers) => {
  const status = headers[':status'];
  console.log('');
  console.log('=== Response ===');
  console.log('Status:', status);
  console.log('apns-id:', headers['apns-id']);
});

let data = '';
req.on('data', (chunk) => {
  data += chunk;
});

req.on('end', () => {
  if (data) {
    console.log('Body:', data);
  } else {
    console.log('Body: (empty - success!)');
  }
  client.close();
});

req.write(payload);
req.end();
