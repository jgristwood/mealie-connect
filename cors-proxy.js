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
const DEFAULT_PROXY_PORT = Number(process.env.PROXY_PORT || 3001);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

function startProxy(port) {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const corsOrigin = LOCALHOST_ORIGIN_RE.test(origin) ? origin : '*';

    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    const targetPath = req.url;
    const targetUrl = new URL(targetPath, MEALIE_SERVER);
    const hasAuth = req.headers.authorization ? '✓' : '✗';
    console.log(`${req.method} ${targetPath} [auth: ${hasAuth}]`);

    const forwardedHeaders = { ...req.headers };
    delete forwardedHeaders.origin;
    delete forwardedHeaders.host;
    delete forwardedHeaders.connection;
    forwardedHeaders.host = targetUrl.host;

    if (forwardedHeaders.authorization) {
      console.log(`  → Forwarding auth: ${forwardedHeaders.authorization.substring(0, 40)}...`);
    }

    const options = {
      method: req.method,
      headers: forwardedHeaders,
    };
    const protocol = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = protocol.request(targetUrl, options, (proxyRes) => {
      console.log(`  ← Response: ${proxyRes.statusCode}`);

      const responseHeaders = {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Authorization',
      };

      const allHeaders = {
        ...proxyRes.headers,
        ...responseHeaders,
      };

      delete allHeaders.connection;
      delete allHeaders['keep-alive'];
      delete allHeaders['transfer-encoding'];

      res.writeHead(proxyRes.statusCode, allHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`❌ Proxy error: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Bad Gateway',
        message: `Could not reach Mealie server at ${MEALIE_SERVER}. Make sure it's running and accessible.`,
        details: err.message,
      }));
    });

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

  server.listen(port, 'localhost', () => {
    console.log(`🟢 Proxy is listening on http://localhost:${port}\n`);
    console.log('📝 Instructions:');
    console.log(`1. In Mealie Connect setup, enter: http://localhost:${port}`);
    console.log('2. Enter your Mealie username and password');
    console.log('3. The proxy will forward all requests to your actual Mealie server\n');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`⚠️ Port ${port} is already in use. Retrying on ${nextPort}...`);
      server.close();
      startProxy(nextPort);
      return;
    }

    console.error(`❌ Server error: ${err.message}`);
    process.exit(1);
  });
}

startProxy(DEFAULT_PROXY_PORT);
