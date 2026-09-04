import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { resolvePublicIdentity } from "./src/lib/publicIdentity.ts";

export default defineConfig(({ mode }) => {
  resolvePublicIdentity({ ...loadEnv(mode, process.cwd()), MODE: mode });

  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: { sourcemap: true },
  };
});
