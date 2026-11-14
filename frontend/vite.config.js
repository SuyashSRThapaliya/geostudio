import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run build` writes frontend/dist, which Flask serves (python run.py).
// `npm run dev` is only for people changing the frontend: it reloads on save and
// forwards /api to Flask on 127.0.0.1:8000.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8000" } },
});
