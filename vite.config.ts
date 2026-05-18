import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium-next';

export default defineConfig({
  base: '/WorldHUD/',
  plugins: [cesium()],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    cors: true,
    hmr: { clientPort: 443 },
  },
  build: {
    rollupOptions: { input: 'index.html' },
  },
});
