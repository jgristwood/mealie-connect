import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
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
})
