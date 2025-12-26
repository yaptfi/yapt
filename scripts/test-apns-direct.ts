/**
 * Direct APNs test - bypasses the apn library entirely
 * Usage: APNS_KEY_PATH=... APNS_KEY_ID=... APNS_TEAM_ID=... npx tsx scripts/test-apns-direct.ts <device_token>
 */

import http2 from 'http2';
import fs from 'fs';
import jwt from 'jsonwebtoken';

const APNS_KEY_PATH = process.env.APNS_KEY_PATH!;
const APNS_KEY_ID = process.env.APNS_KEY_ID!;
const APNS_TEAM_ID = process.env.APNS_TEAM_ID!;
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.yapt.Yapt';
const DEVICE_TOKEN = process.argv[2];

if (!DEVICE_TOKEN) {
  console.error('Usage: npx tsx scripts/test-apns-direct.ts <device_token>');
  process.exit(1);
}

// Use sandbox for Xcode builds
const APNS_HOST = 'api.sandbox.push.apple.com';

console.log('=== APNs Direct Test ===');
console.log('Host:', APNS_HOST);
console.log('Bundle ID:', APNS_BUNDLE_ID);
console.log('Team ID:', APNS_TEAM_ID);
console.log('Key ID:', APNS_KEY_ID);
console.log('Token (last 8):', DEVICE_TOKEN.slice(-8));
console.log('');

// Generate JWT
const key = fs.readFileSync(APNS_KEY_PATH);
const token = jwt.sign({
  iss: APNS_TEAM_ID,
  iat: Math.floor(Date.now() / 1000),
}, key, {
  algorithm: 'ES256',
  header: {
    alg: 'ES256',
    kid: APNS_KEY_ID,
  },
});

console.log('JWT generated successfully');
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
const client = http2.connect(`https://${APNS_HOST}`);

client.on('error', (err) => {
  console.error('Connection error:', err);
  process.exit(1);
});

const req = client.request({
  ':method': 'POST',
  ':path': `/3/device/${DEVICE_TOKEN}`,
  'authorization': `bearer ${token}`,
  'apns-topic': APNS_BUNDLE_ID,
  'apns-push-type': 'alert',
  'apns-priority': '10',
  'content-type': 'application/json',
});

req.on('response', (headers) => {
  const status = headers[':status'];
  console.log('Response status:', status);
  console.log('apns-id:', headers['apns-id']);
  console.log('apns-unique-id:', headers['apns-unique-id']);
});

let data = '';
req.on('data', (chunk) => {
  data += chunk;
});

req.on('end', () => {
  if (data) {
    console.log('Response body:', data);
  } else {
    console.log('Success! No error body returned.');
  }
  client.close();
});

req.write(payload);
req.end();
