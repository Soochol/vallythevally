import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("Chromium은 샌드박스를 켠 채 뜬다", async ({ browser }) => {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const browserProcess = processInfo.find((p) => p.type === "browser");
  expect(browserProcess, "브라우저 프로세스").toBeDefined();
  const args = (await readFile(`/proc/${browserProcess!.id}/cmdline`, "utf8")).split(/[\0\s]+/);
  console.log(JSON.stringify({ pid: browserProcess!.id, sandboxFlags: args.filter((a) => a.includes("sandbox")) }));
  expect(args).not.toContain("--no-sandbox");
});
