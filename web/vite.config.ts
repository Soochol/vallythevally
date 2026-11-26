/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fakeApi } from "./dev/fakeApi.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const useFakeApi = env.VITE_FAKE_API !== "0";
  const backend = env.VITE_API_TARGET || "http://127.0.0.1:8080";
  return {
    plugins: [react(), tailwindcss(), useFakeApi ? fakeApi(env.VITE_FAKE_SCREENER) : null],
    server: {
      host: "127.0.0.1",
      proxy: useFakeApi
        ? undefined
        : {
            "/api": {
              target: backend,
              ws: true,
              changeOrigin: true,
              configure: (proxy) => {
                const asBackendOrigin = (proxyReq: { getHeader(name: string): unknown; setHeader(name: string, value: string): void }) => {
                  if (proxyReq.getHeader("origin") !== undefined) proxyReq.setHeader("origin", backend);
                };
                proxy.on("proxyReq", asBackendOrigin);
                proxy.on("proxyReqWs", asBackendOrigin);
              },
            },
          },
    },
    test: { environment: "node", include: ["src/**/*.test.{ts,tsx}", "dev/**/*.test.ts"], css: { include: [/\.css\?raw$/] } },
  };
});
