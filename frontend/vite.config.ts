import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // The icon sprite must stay a file: <use href="file.svg#name"> does not work with an inlined data address.
    assetsInlineLimit: (file) => (file.endsWith(".svg") ? false : undefined),
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});
