import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During development the React app runs on :5173 and forwards /api calls to Flask on :5000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 127.0.0.1, not "localhost": Node 18+ may resolve localhost to IPv6 (::1) while Flask listens on IPv4.
    proxy: { "/api": "http://127.0.0.1:5000" },
  },
});
