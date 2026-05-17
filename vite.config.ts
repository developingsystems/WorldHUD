import { defineConfig } from "vite";

export default defineConfig({
  plugins: [],
  server: {
    host: true,   // ← eliminates the IPv4/IPv6 mismatch for Codespaces
  },
});
