/**
 * Simple CORS Proxy for Mealie Connect
 * 
 * This proxy runs on localhost:3001 and forwards requests to your Mealie server
 * while adding CORS headers to all responses.
 * 
 * Usage:
 *   node cors-proxy.js
 * 
 * Then set MEALIE_PROXY_URL=http://localhost:3001 in your environment
 */

import http from 'http';
import https from 'https';

const MEALIE_SERVER = process.env.MEALIE_SERVER || 'http://192.168.50.10:9925';
const PROXY_PORT = process.env.PROXY_PORT || 3001;
const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];

console.log(`🔄 CORS Proxy starting on http://localhost:${PROXY_PORT}`);
console.log(`📍 Forwarding to: ${MEALIE_SERVER}`);
console.log(`✓ Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
console.log('');
console.log('Configuration:');
console.log('  In your Mealie Connect setup, use: http://localhost:3001');
console.log('');

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // Parse the target URL
  const targetPath = req.url;
  const targetUrl = new URL(targetPath, MEALIE_SERVER);

  // Log with method, path, and auth status
  const hasAuth = req.headers.authorization ? '✓' : '✗';
  console.log(`${req.method} ${targetPath} [auth: ${hasAuth}]`);

  // Create a COPY of headers instead of modifying original
  const forwardedHeaders = { ...req.headers };
  
  // Remove proxy-specific headers
  delete forwardedHeaders['origin'];
  delete forwardedHeaders['host'];
  delete forwardedHeaders['connection'];
  
  // Set correct host for target server
  forwardedHeaders['host'] = targetUrl.host;
  
  // Ensure we keep the authorization header
  if (forwardedHeaders.authorization) {
    console.log(`  → Forwarding auth: ${forwardedHeaders.authorization.substring(0, 40)}...`);
  }

  const options = {
    method: req.method,
    headers: forwardedHeaders,
  };

  // Choose http or https
  const protocol = targetUrl.protocol === 'https:' ? https : http;

  const proxyReq = protocol.request(targetUrl, options, (proxyRes) => {
    // Log response status
    console.log(`  ← Response: ${proxyRes.statusCode}`);
    
    // Add CORS headers to response
    const responseHeaders = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Authorization',
    };

    // Copy original headers and add CORS
    const allHeaders = {
      ...proxyRes.headers,
      ...responseHeaders,
    };
    
    // Remove hop-by-hop headers
    delete allHeaders['connection'];
    delete allHeaders['keep-alive'];
    delete allHeaders['transfer-encoding'];

    res.writeHead(proxyRes.statusCode, allHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`❌ Proxy error: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Bad Gateway',
        message: `Could not reach Mealie server at ${MEALIE_SERVER}. Make sure it's running and accessible.`,
        details: err.message,
      }),
    );
  });

  // Handle request body for non-GET requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.on('data', (chunk) => {
      proxyReq.write(chunk);
    });
    req.on('end', () => {
      proxyReq.end();
    });
    req.on('error', (err) => {
      console.error(`❌ Request error: ${err.message}`);
      proxyReq.destroy();
    });
  } else {
    proxyReq.end();
  }
});

server.listen(PROXY_PORT, 'localhost', () => {
  console.log(`🟢 Proxy is listening on http://localhost:${PROXY_PORT}\n`);
  console.log('📝 Instructions:');
  console.log('1. In Mealie Connect setup, enter: http://localhost:3001');
  console.log('2. Enter your Mealie username and password');
  console.log('3. The proxy will forward all requests to your actual Mealie server\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PROXY_PORT} is already in use. Try setting PROXY_PORT=3002`);
  } else {
    console.error(`❌ Server error: ${err.message}`);
  }
  process.exit(1);
});
