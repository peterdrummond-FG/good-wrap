import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { quasar, transformAssetUrls } from "@quasar/vite-plugin";

// Proxies /api to the Stage 4 Fastify server (src/server/) so the dashboard
// can call relative paths in dev without a CORS dance. That server also
// registers permissive CORS itself, so this proxy is really just a
// convenience, not a requirement.
export default defineConfig({
  plugins: [
    vue({ template: { transformAssetUrls } }),
    quasar({ sassVariables: false }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
      },
    },
  },
});
