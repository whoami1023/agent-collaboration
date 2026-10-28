import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5274,
    host: "127.0.0.1",
    fs: { allow: [repoRoot] },
    proxy: {
      "/api": "http://127.0.0.1:8788",
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
