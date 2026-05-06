import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const HMR_PORT = 1421;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Tauri expects a fixed port and complains if it pivots.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "0.0.0.0",
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: HMR_PORT,
    },
    watch: {
      // Don't reload the dev server when Rust files change — Tauri restarts on its own.
      ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"],
    },
  },
}));
