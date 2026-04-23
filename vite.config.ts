import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** GitHub Pages 등 서브패스 배포: `VITE_BASE_PATH=/리포이름/` */
const base = (process.env.VITE_BASE_PATH ?? "/").replace(/\/?$/, "/");

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 2000
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true
      }
    }
  },
  preview: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true
      }
    }
  }
});
