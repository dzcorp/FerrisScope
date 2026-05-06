import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest config — separate from vite.config.ts because the latter pulls in
// Tailwind, which slows test startup and offers no value for unit tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // No tests touch the disk; speed up by not parsing the world.
    css: false,
  },
  resolve: {
    alias: {
      // Tests stub @tauri-apps/api invoke at the boundary so components
      // can render without a real Tauri runtime.
      "@tauri-apps/api/core": "/src/test/tauri-mock.ts",
      "@tauri-apps/api/event": "/src/test/tauri-event-mock.ts",
    },
  },
});
