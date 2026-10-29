import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Send /api requests to the Express server during development.
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
});
