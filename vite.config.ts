import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  root: '.',          // <-- ensure Vite uses the project root
  server: {
    host: true,
    port: 5173,
    hmr: {
      clientPort: 443,
    },
  },
  build: {
    rollupOptions: {
      input: './index.html',   // <-- explicitly point to the root index.html
    },
  },
});
