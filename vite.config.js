import { defineConfig } from 'vite';
import { resolve } from 'path';

// Multi-page app: index.html = host (TV) view, player.html = player (phone) view
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        host: resolve(__dirname, 'index.html'),
        player: resolve(__dirname, 'player.html')
      }
    }
  }
});
