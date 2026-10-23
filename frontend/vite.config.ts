import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const FLASK = process.env.FLASK_URL ?? "http://localhost:5050";
const SERVER_PATHS = ["/api", "/auth", "/login", "/static", "/images", "/graphs", "/health"];

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    proxy: {
      ...Object.fromEntries(SERVER_PATHS.map((path) => [path, { target: FLASK }])),
      "/ws": { target: FLASK, ws: true },
    },
  },
});
