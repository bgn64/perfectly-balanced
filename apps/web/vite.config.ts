import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
export default defineConfig({
  plugins: [react()],
  server: process.env.LOCAL_HTTPS === "true" ? {
    host:"127.0.0.1",port:5174,strictPort:true,
    https:{
      key:readFileSync(new URL("../../backups/local-https/key.pem",import.meta.url)),
      cert:readFileSync(new URL("../../backups/local-https/cert.pem",import.meta.url)),
    },
  } : undefined,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@supabase/")) return "supabase";
          if (id.includes("/node_modules/zod/")) return "validation";
        },
      },
    },
  },
});
