import type { Page } from "@playwright/test";

export async function holdDecoder(page: Page): Promise<() => Promise<void>> {
  await page.addInitScript(() => {
    const Original = window.DecompressionStream;
    const gate = new Promise<void>((resolve) => window.addEventListener("release-inflate", () => resolve(), { once: true }));
    window.DecompressionStream = class extends Original {
      constructor(format: CompressionFormat) {
        super(format);
        Object.defineProperty(this, "readable", { value: this.readable.pipeThrough(new TransformStream({ async transform(chunk, controller) { await gate; controller.enqueue(chunk); } })) });
      }
    };
    document.addEventListener("toggle", (event) => {
      if (event.target instanceof HTMLDetailsElement && event.target.dataset.evidence === "publication") event.target.dataset.earlyToggleSeen = "true";
    }, true);
  });
  return async () => { await page.evaluate(() => window.dispatchEvent(new Event("release-inflate"))); };
}
