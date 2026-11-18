import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useSelectionStore } from "../../stores/selection";
import { receiveCollectorDaemon } from "./alerts";

class FakeNotification {
  static permission: NotificationPermission = "default";
  static shown: string[] = [];
  constructor(title: string, options: NotificationOptions) {
    FakeNotification.shown.push(`${title}|${options.body}`);
  }
}

beforeEach(() => {
  FakeNotification.permission = "default";
  FakeNotification.shown = [];
  vi.stubGlobal("Notification", FakeNotification);
  useSelectionStore.setState({ toast: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("데몬 알림", () => {
  test("꺼짐과 응답 없음은 화면 안 알림을 띄운다", () => {
    receiveCollectorDaemon("down", 1);
    expect(useSelectionStore.getState().toast?.text).toBe("수집 감독 데몬이 꺼졌습니다");
    receiveCollectorDaemon("unresponsive", 2);
    expect(useSelectionStore.getState().toast?.text).toBe("수집 감독 데몬이 응답하지 않습니다");
  });

  test("그 밖의 판단은 아무것도 띄우지 않는다", () => {
    receiveCollectorDaemon("healthy", 1);
    expect(useSelectionStore.getState().toast).toBeNull();
    expect(FakeNotification.shown).toEqual([]);
  });

  test("브라우저 알림은 허락이 있을 때만 띄운다", () => {
    receiveCollectorDaemon("down", 1);
    expect(FakeNotification.shown).toEqual([]);
    FakeNotification.permission = "denied";
    receiveCollectorDaemon("down", 2);
    expect(FakeNotification.shown).toEqual([]);
    FakeNotification.permission = "granted";
    receiveCollectorDaemon("down", 3);
    expect(FakeNotification.shown).toEqual(["수집 현황판|수집 감독 데몬이 꺼졌습니다"]);
  });

  test("브라우저가 알림을 지원하지 않아도 화면 안 알림은 뜬다", () => {
    vi.stubGlobal("Notification", undefined);
    receiveCollectorDaemon("unresponsive", 1);
    expect(useSelectionStore.getState().toast?.text).toBe("수집 감독 데몬이 응답하지 않습니다");
  });
});
