import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  server: {
    host: 'true',
    port: 5173,
    strictPort: false,   // fall back to another port if 5173 is taken
    cors: true,
    hmr: {
      clientPort: 443,
    },
  },
  build: {
    rollupOptions: {
      input: 'index.html',
    },
  },
});
