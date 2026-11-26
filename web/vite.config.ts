/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fakeApi } from "./dev/fakeApi.ts";

// VITE_FAKE_API=0 이면 /api를 실제 서버로 보낸다. 그 밖에는 dev 서버가 가짜 API로 답한다.
const BACKEND = "http://127.0.0.1:8080";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const useFakeApi = env.VITE_FAKE_API !== "0";
  return {
    plugins: [react(), tailwindcss(), useFakeApi ? fakeApi(env.VITE_FAKE_SCREENER) : null],
    server: {
      host: "127.0.0.1",
      proxy: useFakeApi
        ? undefined
        : {
            "/api": {
              target: BACKEND,
              ws: true,
              changeOrigin: true,
              configure: (proxy) => {
                const asBackendOrigin = (proxyReq: { getHeader(name: string): unknown; setHeader(name: string, value: string): void }) => {
                  if (proxyReq.getHeader("origin") !== undefined) proxyReq.setHeader("origin", BACKEND);
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
