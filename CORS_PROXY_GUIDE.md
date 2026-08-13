# Mealie Connect - CORS Proxy Setup Guide

## The CORS Problem

When connecting to a self-hosted Mealie server from your browser, you may see this error:

```
Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource.
(Reason: CORS header 'Access-Control-Allow-Origin' missing)
```

This happens because your browser has a security restriction that prevents web apps from making requests to servers on different domains/ports. Your Mealie server at `192.168.50.10:9925` looks like a different origin from your browser at `localhost:5173`.

## Solution: Use the CORS Proxy

This app includes a simple CORS proxy (`cors-proxy.js`) that runs locally and forwards requests to your Mealie server while adding the necessary CORS headers.

### How It Works

```
Your Browser (localhost:5173)
    ↓ (requests to http://localhost:3001)
CORS Proxy (localhost:3001)
    ↓ (forwards with CORS headers to)
Mealie Server (192.168.50.10:9925)
```

## Setup Instructions

### 1. Start the CORS Proxy

Open a terminal in the `mealie-connect` folder and run:

```bash
node cors-proxy.js
```

You should see output like:
```
🔄 CORS Proxy starting on http://localhost:3001
📍 Forwarding to: http://192.168.50.10:9925
✓ Allowed origins: http://localhost:5173, http://localhost:3000, http://127.0.0.1:5173

🟢 Proxy is listening on http://localhost:3001

📝 Instructions:
1. In Mealie Connect setup, enter: http://localhost:3001
2. Enter your Mealie username and password
3. The proxy will forward all requests to your actual Mealie server
```

### 2. Configure Your Mealie Server URL

When setting up Mealie Connect:

1. Open Mealie Connect and click "Connect to Mealie"
2. In the **Server URL** field, enter: `http://localhost:3001`
3. Enter your Mealie username and password
4. Click Continue

### 3. Done!

The app will now work smoothly with your self-hosted Mealie server. All requests go through the proxy, which handles CORS automatically.

## Advanced Configuration

### Using a Different Proxy Port

If port 3001 is already in use on your system, you can specify a different port:

```bash
PROXY_PORT=3002 node cors-proxy.js
```

Then use `http://localhost:3002` in Mealie Connect instead.

### Proxying a Different Mealie Server

By default, the proxy forwards to `http://192.168.50.10:9925`. To proxy a different server:

```bash
MEALIE_SERVER=https://mealie.example.com node cors-proxy.js
```

## Alternative Solutions

### Option 1: Configure CORS on Your Mealie Server (Permanent)

The best long-term solution is to configure CORS on your Mealie server itself:

1. Access your Mealie server's configuration
2. Add CORS headers to allow requests from your browser origin
3. For a local setup, you might add `http://localhost:5173` to allowed origins

This is documented in the Mealie project documentation.

### Option 2: Browser Extension

Some users install CORS browser extensions (not recommended for security reasons).

### Option 3: Run Mealie Behind a Reverse Proxy

If Mealie is behind nginx or another reverse proxy, configure CORS headers there.

## Troubleshooting

### "Port 3001 is already in use"

Use a different port:
```bash
PROXY_PORT=3002 node cors-proxy.js
```

### "Could not reach Mealie server"

- Verify your Mealie server is running
- Check the server URL is correct (try opening it in your browser)
- Verify network connectivity between your computer and the Mealie server

### Still getting errors?

1. Check your browser console (F12) for detailed error messages
2. Verify the proxy is running and showing request logs
3. Ensure the Mealie server URL is correct

## How to Stop the Proxy

Simply press `Ctrl+C` in the terminal where the proxy is running.

## Security Notes

- The CORS proxy runs locally on your computer only
- All requests are forwarded to your Mealie server; credentials are passed through
- The proxy does not store any data
- For production deployments, it's recommended to configure CORS on your actual Mealie server instead
