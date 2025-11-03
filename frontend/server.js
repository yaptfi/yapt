/* Lightweight static server for the frontend */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5173;
const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';
const HTTPS_CERT = process.env.HTTPS_CERT || '';
const HTTPS_KEY = process.env.HTTPS_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const requestHandler = (req, res) => {
  // Normalize path and prevent path traversal; ensure we don't treat it as absolute
  const raw = (req.url || '/').split('?')[0] || '/';
  let safe = path.normalize(raw).replace(/^([.]{2}[\/])+/, '');
  if (safe.startsWith('/')) safe = safe.slice(1);

  // Default to index.html for root
  if (safe === '' || safe === '.') {
    safe = 'index.html';
  }

  let filePath = path.join(root, safe);

  // If directory, try index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.end(data);
  });
};

// Create HTTP or HTTPS server depending on configuration
let server;
if (HTTPS_ENABLED && HTTPS_CERT && HTTPS_KEY) {
  try {
    const options = {
      key: fs.readFileSync(HTTPS_KEY),
      cert: fs.readFileSync(HTTPS_CERT),
    };
    server = https.createServer(options, requestHandler);
    console.log('Frontend HTTPS enabled');
  } catch (error) {
    console.error('Failed to load HTTPS certificates for frontend:', error);
    console.error('Falling back to HTTP');
    server = http.createServer(requestHandler);
  }
} else {
  server = http.createServer(requestHandler);
}

server.listen(PORT, () => {
  const protocol = HTTPS_ENABLED ? 'https' : 'http';
  // eslint-disable-next-line no-console
  console.log(`Frontend running at ${protocol}://localhost:${PORT}`);
});
