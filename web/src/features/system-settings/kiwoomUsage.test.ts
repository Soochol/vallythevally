import { describe, expect, it } from "vitest";
import type { KiwoomUsage } from "../../api/generated/KiwoomUsage";
import type { KiwoomUsageTr } from "../../api/generated/KiwoomUsageTr";
import { FIRST_MINUTE_MESSAGE, formatMillis, NO_ROWS_MESSAGE, rowView, usageView } from "./kiwoomUsage";

const tr = (apiId: string, patch: Partial<KiwoomUsageTr["lastMinute"]> = {}, rest: Partial<KiwoomUsageTr> = {}): KiwoomUsageTr => ({
  apiId, limit: 5, totalSent: 40, totalRateLimited: 0, ...rest,
  lastMinute: { sent: 14, maxPerSecond: 2, maxWaitMs: 0, rateLimited: 0, resent: 0, ...patch },
});
const usage = (trs: KiwoomUsageTr[], patch: Partial<KiwoomUsage> = {}): KiwoomUsage => ({ lastMinuteStartedAt: 1_794_000_000, totalRateLimited: 0, trs, ...patch });

describe("한도에 닿음", () => {
  it("1초 최대가 한도와 같고 기다림이 0보다 크면 닿은 것이다", () => {
    expect(rowView(tr("ka10003", { maxPerSecond: 5, maxWaitMs: 1050 }))).toMatchObject({ peak: "5 / 5", maxWait: "1,050ms", hitLimit: true });
  });
  it("한도와 같아도 기다리지 않았으면 닿은 것이 아니다", () => {
    expect(rowView(tr("ka10003", { maxPerSecond: 5, maxWaitMs: 0 })).hitLimit).toBe(false);
  });
  it("기다렸어도 1초 최대가 한도 아래면 닿은 것이 아니다", () => {
    expect(rowView(tr("ka10003", { maxPerSecond: 4, maxWaitMs: 300 })).hitLimit).toBe(false);
  });
  it("유량으로 바뀐 한도를 기준으로 본다", () => {
    expect(rowView(tr("ka10080", { maxPerSecond: 3, maxWaitMs: 200 }, { limit: 3 }))).toMatchObject({ peak: "3 / 3", hitLimit: true });
  });
});

describe("경고", () => {
  it("지난 1분에 제한 응답이 있으면 경고다", () => {
    expect(rowView(tr("ka10080", { rateLimited: 1 })).warning).toBe(true);
  });
  it("지난 1분에는 없어도 서버를 켠 뒤 제한 응답이 있으면 경고다", () => {
    expect(rowView(tr("ka10080", {}, { totalRateLimited: 2 })).warning).toBe(true);
  });
  it("제한 응답이 한 번도 없으면 경고가 아니다", () => {
    expect(rowView(tr("ka10080")).warning).toBe(false);
  });
});

describe("TR 뜻", () => {
  it("표에 있는 TR은 짧은 뜻을 붙인다", () => {
    expect(rowView(tr("ka10095")).meaning).toBe("현재가·당일 요약");
    expect(rowView(tr("kt10003")).meaning).toBe("취소 주문");
  });
  it("표에 없는 TR은 api-id만 보인다", () => {
    expect(rowView(tr("ka99999"))).toMatchObject({ apiId: "ka99999", meaning: null });
  });
});

describe("카드 내용", () => {
  it("머리에 지난 1분이 시작한 시각(KST)과 서버를 켠 뒤 제한 응답 수를 싣는다", () => {
    const view = usageView(usage([tr("ka10095")], { lastMinuteStartedAt: Date.UTC(2026, 10, 19, 2, 42, 10) / 1000, totalRateLimited: 3 }));
    expect(view).toMatchObject({ lastMinute: "11:42", totalRateLimited: 3, emptyMessage: null });
    expect(view.rows).toHaveLength(1);
  });
  it("줄이 없으면 지난 1분에 보낸 조회가 없다고 알린다", () => {
    expect(usageView(usage([])).emptyMessage).toBe(NO_ROWS_MESSAGE);
  });
  it("아직 1분이 지나지 않았으면 1분 뒤부터 보인다고 알린다", () => {
    expect(usageView(usage([], { lastMinuteStartedAt: null }))).toMatchObject({ emptyMessage: FIRST_MINUTE_MESSAGE, lastMinute: "아직 없음" });
  });
  it("1분이 지나기 전이라도 제한 응답 줄이 있으면 줄을 보인다", () => {
    const view = usageView(usage([tr("ka10080", { sent: 0, maxPerSecond: 0 }, { totalRateLimited: 1 })], { lastMinuteStartedAt: null, totalRateLimited: 1 }));
    expect(view.emptyMessage).toBeNull();
    expect(view.rows[0]).toMatchObject({ apiId: "ka10080", warning: true });
  });
});

describe("밀리초 표기", () => {
  it("천 단위를 쉼표로 묶는다", () => {
    expect([formatMillis(0), formatMillis(1050)]).toEqual(["0ms", "1,050ms"]);
  });
});
