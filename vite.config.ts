import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const packageVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }).version

/** Path the dev server forwards to MEALIE_SERVER, so the app can talk to a
 * real Mealie server from localhost without CORS changes on that server. */
const DEV_PROXY_PATH = '/__mealie'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const mealieServer = env.MEALIE_SERVER?.trim().replace(/\/+$/, '')
  const devProxyPath = command === 'serve' && mealieServer ? DEV_PROXY_PATH : ''

  return {
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion),
    __MEALIE_DEV_PROXY_PATH__: JSON.stringify(devProxyPath),
  },
  server: mealieServer ? {
    proxy: {
      [`^${DEV_PROXY_PATH}/`]: {
        target: mealieServer,
        changeOrigin: true,
        secure: true,
        rewrite: (path: string) => path.slice(DEV_PROXY_PATH.length),
        configure: (proxy) => {
          // Present requests to Mealie as same-origin, like the native app.
          proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'))
        },
      },
    },
  } : undefined,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['mealie-connect-logo.svg'],
      manifest: {
        name: 'Mealie Connect',
        short_name: 'Mealie Connect',
        description: 'Mealie Connect — Your Mealie cooking companion',
        theme_color: '#7c3aed',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '/',
        orientation: 'portrait-primary',
        icons: [
          {
            src: 'mealie-connect-logo.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
          },
          {
            src: 'mealie-connect-logo.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
          },
        ],
      },
    }),
  ],
}
})
