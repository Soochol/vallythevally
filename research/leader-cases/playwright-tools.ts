import { createRequire } from "node:module";
import type * as Playwright from "@playwright/test";

const playwright: typeof Playwright = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
export const { defineConfig, expect, test } = playwright;
