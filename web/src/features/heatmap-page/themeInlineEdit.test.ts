import { expect, test } from "vitest";
import type { HeatmapBoard } from "../../api/generated/HeatmapBoard";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { createSerialQueue, projectBoardThemes, rateIntensityLevel, snapshotVisualThemes } from "./themeInlineEdit";

const code = (value: string) => value as SymbolCode;

const SAMPLE_BOARD: HeatmapBoard = {
  revision: 10,
  order: "rate",
  asOf: 1_794_182_400,
  source: "mine",
  catalog: null,
  themes: [
    {
      id: "t-a",
      name: "반도체",
      summary: { weightedRate: 2.0, tradedMillionWon: 500_000, rising: 2, flat: 0, falling: 0, leader: code("000660") },
      members: [
        { symbol: code("005930"), name: "삼성전자", changeRate: 1.0, tradedMillionWon: 300_000 },
        { symbol: code("000660"), name: "SK하이닉스", changeRate: 3.5, tradedMillionWon: 200_000 },
      ],
      missing: [],
    },
    {
      id: "t-b",
      name: "바이오",
      summary: { weightedRate: -3.2, tradedMillionWon: 200_000, rising: 0, flat: 0, falling: 1, leader: code("196170") },
      members: [
        { symbol: code("196170"), name: "알테오젠", changeRate: -3.2, tradedMillionWon: 200_000 },
      ],
      missing: [],
    },
  ],
};

test("등락률 크기에 따라 4단계 헤더 강도를 구분한다", () => {
  expect(rateIntensityLevel(null)).toBe(0);
  expect(rateIntensityLevel(0)).toBe(0);
  expect(rateIntensityLevel(0.29)).toBe(0);
  expect(rateIntensityLevel(-0.29)).toBe(0);
  expect(rateIntensityLevel(0.3)).toBe(1);
  expect(rateIntensityLevel(-1.49)).toBe(1);
  expect(rateIntensityLevel(1.5)).toBe(2);
  expect(rateIntensityLevel(-2.99)).toBe(2);
  expect(rateIntensityLevel(3.0)).toBe(3);
  expect(rateIntensityLevel(-5.4)).toBe(3);
});

test("낙관적 보드 투영은 옮긴 종목과 가중 평균을 즉시 반영한다", () => {
  const projected = projectBoardThemes(
    SAMPLE_BOARD,
    [
      { id: "t-a", name: "반도체", symbols: [code("005930")] },
      { id: "t-b", name: "바이오", symbols: [code("196170"), code("000660")] },
      { id: "t-c", name: "신규", symbols: [code("999999")] },
    ],
    "custom",
  );
  expect(projected.themes.map((theme) => theme.name)).toEqual(["반도체", "바이오", "신규"]);
  expect(projected.themes[0]!.summary?.weightedRate).toBe(1);
  expect(projected.themes[1]!.summary?.weightedRate).toBeCloseTo(0.15, 4);
  expect(projected.themes[2]!.missing).toEqual([code("999999")]);
});

test("현재 화면 정렬 상태를 스냅샷해 내 순서 전환 시 종목 순서를 보존한다", () => {
  const snapped = snapshotVisualThemes(SAMPLE_BOARD.themes, "rate", new Map());
  expect(snapped[0]!.symbols).toEqual([code("000660"), code("005930")]);
});

test("직렬 저장 큐는 작업이 겹치지 않고 순서대로 실행된다", async () => {
  const enqueue = createSerialQueue();
  const log: string[] = [];
  let releaseFirst!: () => void;
  const first = enqueue(async () => {
    log.push("start-1");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    log.push("end-1");
    return 1;
  });
  const second = enqueue(async () => {
    log.push("start-2");
    log.push("end-2");
    return 2;
  });
  await Promise.resolve();
  expect(log).toEqual(["start-1"]);
  releaseFirst();
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  expect(log).toEqual(["start-1", "end-1", "start-2", "end-2"]);
});
