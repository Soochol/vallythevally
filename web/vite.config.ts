/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fakeApi } from "./dev/fakeApi.ts";

// VITE_FAKE_API=0 이면 /api를 실제 서버로 보낸다. 그 밖에는 dev 서버가 가짜 API로 답한다.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const useFakeApi = env.VITE_FAKE_API !== "0";
  return {
    plugins: [react(), tailwindcss(), useFakeApi ? fakeApi() : null],
    server: {
      host: "127.0.0.1",
      proxy: useFakeApi ? undefined : { "/api": { target: "http://127.0.0.1:8080", ws: true } },
    },
    test: { environment: "node", include: ["src/**/*.test.ts", "dev/**/*.test.ts"] },
  };
});
