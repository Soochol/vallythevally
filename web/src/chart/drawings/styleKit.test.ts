import { expect, test } from "vitest";
import { defaultText, readTextStyle } from "./styleKit";

test("readTextStyle limits the text size to the 8-72 range of the size field", () => {
  const d = defaultText();
  expect(readTextStyle({ size: -5 }, d).size).toBe(8);
  expect(readTextStyle({ size: 0 }, d).size).toBe(8);
  expect(readTextStyle({ size: 5000 }, d).size).toBe(72);
  expect(readTextStyle({ size: 20 }, d).size).toBe(20);
  expect(readTextStyle({ size: "big" }, d).size).toBe(d.size);
});
