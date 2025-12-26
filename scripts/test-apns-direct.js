/**
 * Direct APNs test - bypasses the apn library entirely
 * Run inside docker: docker-compose exec app node scripts/test-apns-direct.js <device_token>
 */

const http2 = require('http2');
const fs = require('fs');
const crypto = require('crypto');

const APNS_KEY_PATH = process.env.APNS_KEY_PATH || '/app/secrets/AuthKey_62RJ26H8X3.p8';
const APNS_KEY_ID = process.env.APNS_KEY_ID || '62RJ26H8X3';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '9626BEV4Z4';
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.yapt.Yapt';
const DEVICE_TOKEN = process.argv[2];

if (!DEVICE_TOKEN) {
  console.error('Usage: node scripts/test-apns-direct.js <device_token>');
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

// Generate JWT manually (ES256)
function generateJWT() {
  const key = fs.readFileSync(APNS_KEY_PATH);

  const header = {
    alg: 'ES256',
    kid: APNS_KEY_ID,
  };

  const payload = {
    iss: APNS_TEAM_ID,
    iat: Math.floor(Date.now() / 1000),
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const sign = crypto.createSign('SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(key);

  // Convert DER signature to raw r||s format for ES256
  const derSignature = signature;
  let offset = 3;
  const rLength = derSignature[offset];
  offset += 1;
  let r = derSignature.slice(offset, offset + rLength);
  offset += rLength + 1;
  const sLength = derSignature[offset];
  offset += 1;
  let s = derSignature.slice(offset, offset + sLength);

  // Ensure r and s are 32 bytes each
  if (r.length > 32) r = r.slice(r.length - 32);
  if (s.length > 32) s = s.slice(s.length - 32);
  if (r.length < 32) r = Buffer.concat([Buffer.alloc(32 - r.length), r]);
  if (s.length < 32) s = Buffer.concat([Buffer.alloc(32 - s.length), s]);

  const rawSignature = Buffer.concat([r, s]);
  const encodedSignature = rawSignature.toString('base64url');

  return `${signatureInput}.${encodedSignature}`;
}

const jwtToken = generateJWT();
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
  'authorization': `bearer ${jwtToken}`,
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
