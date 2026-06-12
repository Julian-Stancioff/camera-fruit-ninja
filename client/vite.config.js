import { defineConfig } from "vite";

export default defineConfig({
  server: { host: true, port: 5173 },
  build: {
    target: "es2022",
    // The MediaPipe .task model + wasm live in public/ and are copied verbatim.
    assetsInlineLimit: 0,
  },
});
