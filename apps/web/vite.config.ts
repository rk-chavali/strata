import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxying keeps the browser on one origin, so no CORS in development.
    proxy: {
      "/api": {
        target: process.env.STRATA_API ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
