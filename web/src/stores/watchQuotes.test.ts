import { describe, expect, it, vi } from "vitest";
import { subscribeBatched } from "./watchQuotes";

function fakeBook() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    subscribe: (code: string, listener: () => void) => {
      const set = listeners.get(code) ?? new Set();
      listeners.set(code, set.add(listener));
      return () => {
        set.delete(listener);
      };
    },
    change: (...codes: string[]) => codes.forEach((code) => listeners.get(code)?.forEach((listener) => listener())),
  };
}

describe("여러 종목 묶어 듣기", () => {
  it("한 묶음에서 여러 종목이 바뀌어도 한 번만 알리고 그만 들으면 알리지 않는다", async () => {
    const book = fakeBook();
    const heard = vi.fn();
    const stop = subscribeBatched(book, ["005930", "000660", "035420"], heard);

    book.change("005930", "000660", "035420", "000660");
    expect(heard).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(heard).toHaveBeenCalledTimes(1);

    book.change("000660");
    await Promise.resolve();
    expect(heard).toHaveBeenCalledTimes(2);

    book.change("000660");
    stop();
    await Promise.resolve();
    book.change("005930");
    await Promise.resolve();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
