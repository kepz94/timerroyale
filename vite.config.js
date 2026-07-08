import { defineConfig } from 'vite';
import { resolve } from 'path';
import { VitePWA } from 'vite-plugin-pwa';

// Multi-page app: index.html = host (TV) view, player.html = player (phone) view
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        host: resolve(__dirname, 'index.html'),
        player: resolve(__dirname, 'player.html')
      }
    }
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,woff2,svg}'],
        navigateFallback: null
      },
      manifest: {
        name: 'TimerRoyale',
        short_name: 'TimerRoyale',
        description: 'Timer-battle party games — scan a QR, time it blind, land on the target.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#050807',
        theme_color: '#050807',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
});
