import { describe, expect, test } from "vitest";
import { alertKindLabel, bannerOf, BANNERS, bytesText, coverageRatio, daemonAlertText, dateText, keyStateOf, messageRateText, phaseLabel, receivedAtText, restText } from "./labels";

describe("수집 현황판 표시 규칙", () => {
  test("REST 작업이 없으면 없음이고 있으면 끝난 수 / 계획한 수다", () => {
    expect(restText({ planned_jobs: 0, finished_jobs: 0 })).toBe("없음");
    expect(restText({ planned_jobs: 8, finished_jobs: 5 })).toBe("5 / 8");
  });

  test("초당 메시지를 아직 모르면 줄표다", () => {
    const key = { messages_per_second: null } as Parameters<typeof messageRateText>[0];
    expect(messageRateText(key)).toBe("—");
    expect(messageRateText({ ...key, messages_per_second: 412.46 })).toBe("412.5");
  });

  test("경고 띠는 데몬 꺼짐·응답 없음·형식 버전 불일치만 경고다", () => {
    expect(Object.entries(BANNERS).filter(([, b]) => b.alert).map(([j]) => j).sort()).toEqual(["down", "unresponsive", "version_mismatch"]);
    expect(BANNERS.healthy.alert).toBe(false);
    expect(BANNERS.checking.alert).toBe(false);
  });

  test("모르는 판단은 값 그대로 보이고 경고가 아니다", () => {
    expect(bannerOf("starting" as never)).toEqual({ tone: "idle", title: "starting", alert: false });
    expect(bannerOf("down")).toBe(BANNERS.down);
  });

  test("화면 안 알림 문구는 꺼짐과 응답 없음에만 있다", () => {
    expect(daemonAlertText("down")).toBe("수집 감독 데몬이 꺼졌습니다");
    expect(daemonAlertText("unresponsive")).toBe("수집 감독 데몬이 응답하지 않습니다");
    expect(daemonAlertText("healthy")).toBeNull();
    expect(daemonAlertText("checking")).toBeNull();
    expect(daemonAlertText("version_mismatch")).toBeNull();
  });

  test("모르는 단계·종류·상태는 받은 값을 그대로 보인다", () => {
    expect(phaseLabel("new_phase" as never)).toBe("new_phase");
    expect(alertKindLabel("brand_new")).toBe("brand_new");
    expect(alertKindLabel("key_stopped")).toBe("키 멈춤");
    expect(keyStateOf("brand_new" as never)).toEqual({ label: "brand_new", tone: "idle" });
  });

  test("날짜·시각·크기·커버리지 비율의 표기", () => {
    expect(dateText(20261118)).toBe("2026-11-18");
    expect(receivedAtText(Date.parse("2026-11-18T09:30:12+09:00") / 1000)).toBe("2026-11-18 09:30:12");
    for (const t of [9e12, 8.64e12, 8.64e12 - 100, -9e12, Number.NaN, Number.POSITIVE_INFINITY]) expect(receivedAtText(t)).toBe("알 수 없는 시각");
    expect(bytesText(512)).toBe("512 B");
    expect(bytesText(30 * 1024 ** 3)).toBe("30.0 GB");
    expect(bytesText(2048 * 1024 ** 3)).toBe("2.0 TB");
    expect(coverageRatio({ date: 1, state: "complete", verified: true, planned_stocks: 2600, received_stocks: 2588 })).toBe("2,588 / 2,600");
    expect(coverageRatio({ date: 1, state: "incomplete", verified: null, planned_stocks: null, received_stocks: null })).toBe("—");
  });
});
