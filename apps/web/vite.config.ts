import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { createCloudflarePagesHeaders } from "./src/lib/pagesHeaders.ts";
import { resolvePublicWebConfiguration } from "./src/lib/publicIdentity.ts";

export default defineConfig(({ mode }) => {
  const publicConfiguration = resolvePublicWebConfiguration({
    ...loadEnv(mode, process.cwd()),
    MODE: mode,
  });

  return {
    plugins: [
      react(),
      {
        name: "postline-cloudflare-pages-headers",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "_headers",
            source: createCloudflarePagesHeaders(publicConfiguration),
          });
        },
      },
    ],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    // Keep source maps available for local troubleshooting without publishing
    // downloadable application source alongside production assets.
    build: { sourcemap: mode !== "production" },
  };
});
