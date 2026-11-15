import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/monitor/": "http://127.0.0.1:8770",
      "/api": "http://localhost:3000",
      // Python audio service (services/audio). WebSocket + REST.
      "/audio": { target: "http://localhost:8765", ws: true, rewrite: (p) => p.replace(/^\/audio/, "") },
    },
  },
  preview: { port: 4173 },
});
