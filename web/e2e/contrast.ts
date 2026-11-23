import type { Locator, Page } from "@playwright/test";

export type Rgba = [number, number, number, number];

export const resolveColors = (page: Page, colors: string[]): Promise<Rgba[]> =>
  page.evaluate((list) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    return list.map((value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data) as Rgba;
    });
  }, colors);

const luminance = ([r, g, b]: Rgba): number => {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};

export const over = (top: Rgba, base: Rgba): Rgba => {
  const alpha = top[3] / 255;
  return [0, 1, 2].map((index) => Math.round(top[index]! * alpha + base[index]! * (1 - alpha))).concat(255) as Rgba;
};

export const contrastRatio = (foreground: Rgba, background: Rgba): number => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
};

export interface InkOnFill { ink: string; fill: string; opacity: string }

export const inkAndFill = (nodes: Locator): Promise<InkOnFill[]> =>
  nodes.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return { ink: style.color, fill: style.backgroundColor, opacity: style.opacity };
  }));

export async function contrastOf(page: Page, pairs: readonly InkOnFill[], base: string = "#000"): Promise<number[]> {
  const resolved = await resolveColors(page, [base, ...pairs.flatMap((pair) => [pair.ink, pair.fill])]);
  const floor = resolved[0]!;
  return pairs.map((_, index) => {
    const fill = over(resolved[index * 2 + 2]!, floor);
    return contrastRatio(over(resolved[index * 2 + 1]!, fill), fill);
  });
}
