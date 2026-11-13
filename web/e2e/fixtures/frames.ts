import type { Bar } from "../../src/api/generated/Bar";

export function november9BarAt(time: string, close: number, volume = 1000): Bar {
  return { t: Date.parse(`2026-11-09T${time}:00+09:00`) / 1000, o: close, h: close, l: close, c: close, v: volume };
}
