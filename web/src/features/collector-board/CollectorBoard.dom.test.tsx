// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import type { CollectorAccessState } from "../../api/generated/CollectorAccessState";
import type { CollectorCoverage } from "../../api/generated/CollectorCoverage";
import type { CollectorDisk } from "../../api/generated/CollectorDisk";
import type { CollectorStatus } from "../../api/generated/CollectorStatus";
import type { CollectorStatusPage } from "../../api/generated/CollectorStatusPage";
import type { DaemonJudgment } from "../../api/generated/DaemonJudgment";
import { useAccountStore } from "../../stores/account";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useSelectionStore } from "../../stores/selection";
import { resetDomAfterEach } from "../../test/domSetup";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { SystemSettingsDialog } from "../system-settings/SystemSettingsDialog";
import { receiveCollectorDaemon } from "./alerts";
import { CollectorBoard } from "./CollectorBoard";
import { CollectorPage } from "./CollectorPage";

const GB = 1024 ** 3;
const RECEIVED_AT = Date.parse("2026-11-18T09:30:12+09:00") / 1000;

const STATUS: CollectorStatus = {
  date: 20261118,
  phase: "collecting",
  today: { planned_stocks: 2600, receiving_stocks: 2380, register_failed_batches: 1, disconnected_stocks: 190, handed_off_stocks: 30, excluded_stocks: 12 },
  keys: [
    { name: "수집-01", app_key_hash_prefix: "a1b2c3d4", role: "collecting", state: "receiving", stocks: 190, messages_per_second: 412.5, register_failures: 0, restarts: 0, rest: { planned_jobs: 0, finished_jobs: 0 } },
    { name: "수집-02", app_key_hash_prefix: "e5f6a7b8", role: "collecting", state: "disconnected", stocks: 190, messages_per_second: null, register_failures: 1, restarts: 3, rest: { planned_jobs: 8, finished_jobs: 5 } },
    { name: "예비-01", app_key_hash_prefix: "99aa00bb", role: "spare", state: "handed_off", stocks: 0, messages_per_second: 0, register_failures: 0, restarts: 0, rest: { planned_jobs: 0, finished_jobs: 0 } },
  ],
  universe_changes: {
    added: [{ code: "123456", name: "새로상장" }],
    removed: [{ code: "654321", name: "상장폐지" }, { code: "111111", name: "함께폐지" }],
    renamed: [{ code: "005930", from: "삼성전자", to: "삼성전자홀딩스" }],
    halt_started: [{ code: "222222", name: "정지시작" }],
    halt_lifted: [{ code: "333333", name: "정지해제" }],
  },
  observation_day: { verdict: "observed", reasons: ["평일이고 공휴일이 아니다", "KRX 휴장일 목록에 없다"] },
  alerts: [
    { at: "2026-11-18T07:35:00+09:00", kind: "plan_note", message: "전날보다 종목이 3% 넘게 줄어 가장 최근 목록을 씁니다" },
    { at: "2026-11-18T09:12:40+09:00", kind: "key_stopped", message: "수집-02 키가 멈췄습니다" },
  ],
};

const COVERAGE: CollectorCoverage = {
  sent_at: "2026-11-18T09:30:12+09:00",
  days: [
    { date: 20261117, state: "complete", verified: true, planned_stocks: 2600, received_stocks: 2588 },
    { date: 20261116, state: "verify_failed", verified: null, planned_stocks: null, received_stocks: null },
  ],
};

const DISK: CollectorDisk = {
  sent_at: "2026-11-18T09:30:12+09:00",
  disk: {
    filesystem: { free_bytes: 800 * GB, total_bytes: 2048 * GB },
    raw: [{ date: 20261118, bytes: 12 * GB }, { date: 20261117, bytes: 30 * GB }],
    store: [{ date: 20261117, bytes: 20 * GB }],
  },
};

const statusPage = (judgment: DaemonJudgment, status: CollectorStatus | null = STATUS): CollectorStatusPage => ({
  judgment,
  status,
  sent_at: status ? "2026-11-18T09:30:12+09:00" : null,
  received_at: status ? RECEIVED_AT : null,
});

function serveCollector(
  access: CollectorAccessState = "allowed",
  status: CollectorStatusPage = statusPage("healthy"),
  overrides: { coverage?: { status?: number; body?: unknown } } = {},
) {
  let currentAccess = access;
  let currentStatus = status;
  stubFetch(({ pathname }) => {
    if (pathname === "/api/collector/access") return { body: { access: currentAccess } };
    if (pathname === "/api/collector/status") return { body: currentStatus };
    if (pathname === "/api/collector/coverage") return overrides.coverage ?? { body: COVERAGE };
    if (pathname === "/api/collector/disk") return { body: DISK };
    if (pathname === "/api/system/kiwoom/keys") return { body: { keys: [], limit: 5, activeMarketId: null } };
    if (pathname === "/api/system/settings") {
      return {
        body: {
          bind: "127.0.0.1:8080",
          logFilter: "info",
          kiwoomTarget: { kind: "kiwoom", host: null },
          screenerUpdateOnStart: true,
          dbPath: "",
          screenerDbPath: "",
          financialDbPath: "",
          hogaDataDir: null,
          sharedDataDir: null,
          tokenPath: "",
          keyPath: "",
          lockPath: "",
          staticDir: "",
          serverVersion: "0.0.0",
        },
      };
    }
    if (pathname === "/api/account") return { body: { state: "local_only" } };
    return { body: {} };
  });
  return {
    setAccess: (next: CollectorAccessState) => { currentAccess = next; },
    setStatus: (next: CollectorStatusPage) => { currentStatus = next; },
  };
}

beforeEach(() => {
  useSelectionStore.setState({ dialog: null, toasts: [], toast: null });
  useKiwoomLinkStore.setState({ status: null });
  useAccountStore.setState({ status: { state: "local_only" } });
});

resetDomAfterEach();

test("권한이 허용이면 메뉴 항목이 보이고 현황판에 모든 구역이 보인다", async () => {
  serveCollector("allowed");
  useSelectionStore.setState({ dialog: { kind: "system-settings", menu: "collector" } });
  const { client } = renderWithProviders(<SystemSettingsDialog />);

  const panel = screen.getByRole("tabpanel");
  await waitFor(() => expect(within(panel).getByRole("status", { name: "감독 데몬" }).textContent).toContain("감독 데몬이 정상으로 돕니다"));
  expect(within(panel).getByRole("status", { name: "감독 데몬" }).textContent).toContain("2026-11-18 09:30:12");

  const today = within(panel).getByRole("region", { name: "오늘의 요약" });
  expect(today.textContent).toContain("2026-11-18 · 장중 수집");
  for (const value of ["2,600", "2,380", "1", "190", "30", "12"]) expect(today.textContent).toContain(value);

  const keys = within(panel).getByRole("table", { name: "키별 상태" });
  expect(within(keys).getByRole("row", { name: /수집-01/ }).textContent).toContain("받는 중");
  expect(within(keys).getByRole("row", { name: /수집-01/ }).textContent).toContain("412.5");
  expect(within(keys).getByRole("row", { name: /수집-02/ }).textContent).toContain("5 / 8");
  expect(within(keys).getByRole("row", { name: /예비-01/ }).textContent).toContain("인계됨");

  const universe = within(panel).getByRole("region", { name: "종목 목록 변동" });
  expect(universe.textContent).toContain("123456 새로상장");
  expect(universe.textContent).toContain("005930 삼성전자 → 삼성전자홀딩스");
  expect(within(universe).getByRole("list", { name: "종목 목록 안내" }).textContent).toContain("가장 최근 목록을 씁니다");
  expect(within(panel).getByRole("region", { name: "관측일 판단" }).textContent).toContain("KRX 휴장일 목록에 없다");
  expect(within(panel).getByRole("list", { name: "경보 목록" }).textContent).toContain("수집-02 키가 멈췄습니다");
  const covTable = await within(panel).findByRole("table", { name: "날짜별 커버리지" });
  expect(covTable.textContent).toContain("2,588 / 2,600");
  expect(covTable.textContent).toContain("대조 실패");
  await waitFor(() => expect(within(panel).getByRole("region", { name: "디스크 사용량" }).textContent).toContain("800 GB"));
  client.clear();
});

test("권한이 꺼짐·없음이면 메뉴 항목이 없고 다시 열면 바뀐 권한을 따른다", async () => {
  const api = serveCollector("off");
  useSelectionStore.setState({ dialog: { kind: "system-settings", menu: "general" } });
  const offView = renderWithProviders(<SystemSettingsDialog />);
  await screen.findByRole("tab", { name: "계정" });
  expect(screen.queryByRole("tab", { name: "수집 현황판" })).toBeNull();
  offView.client.clear();
  offView.unmount();

  api.setAccess("denied");
  const deniedView = renderWithProviders(<SystemSettingsDialog />);
  await screen.findByRole("tab", { name: "계정" });
  expect(screen.queryByRole("tab", { name: "수집 현황판" })).toBeNull();
  deniedView.client.clear();
  deniedView.unmount();

  api.setAccess("allowed");
  const allowedView = renderWithProviders(<SystemSettingsDialog />);
  expect(await screen.findByRole("tab", { name: "수집 현황판" })).toBeTruthy();
  allowedView.client.clear();
});

test("권한이 없으면 /collector로 직접 열어도 현황판을 그리지 않고 차트로 돌아가고 허용이면 열린다", async () => {
  serveCollector("denied");
  const deniedView = renderWithProviders(
    <Routes>
      <Route path="/collector" element={<CollectorPage />} />
      <Route path="/" element={<div data-testid="chart-home">home</div>} />
    </Routes>,
    { route: "/collector" },
  );
  await waitFor(() => expect(screen.getByTestId("chart-home")).toBeTruthy());
  expect(screen.queryByRole("heading", { name: "수집 현황판" })).toBeNull();
  deniedView.client.clear();
  deniedView.unmount();

  serveCollector("allowed");
  const allowedView = renderWithProviders(
    <Routes>
      <Route path="/collector" element={<CollectorPage />} />
    </Routes>,
    { route: "/collector" },
  );
  expect(await screen.findByRole("heading", { name: "수집 현황판", level: 1 })).toBeTruthy();
  expect(await screen.findByRole("table", { name: "키별 상태" })).toBeTruthy();
  allowedView.client.clear();
});

test("데몬 down·unresponsive 및 실시간 알림·브라우저 Notification 권한·읽기 전용 보장", async () => {
  const shown: string[] = [];
  let permission: NotificationPermission = "default";
  class FakeNotification {
    static get permission() { return permission; }
    static requestPermission() { permission = "granted"; return Promise.resolve(permission); }
    constructor(title: string, options: NotificationOptions) { shown.push(`${title}|${options.body}`); }
  }
  vi.stubGlobal("Notification", FakeNotification);

  const api = serveCollector("allowed", statusPage("down"));
  const { client } = renderWithProviders(<CollectorBoard />);
  const band = await screen.findByRole("alert", { name: "감독 데몬" });
  expect(band.textContent).toContain("감독 데몬이 꺼져 있습니다");
  expect(band.textContent).toContain("2026-11-18 09:30:12");
  expect(band.getAttribute("data-judgment")).toBe("down");

  receiveCollectorDaemon("healthy", RECEIVED_AT);
  expect(screen.queryByText(/수집 감독 데몬이/)).toBeNull();
  receiveCollectorDaemon("down", RECEIVED_AT);
  expect(await screen.findByText("수집 감독 데몬이 꺼졌습니다")).toBeTruthy();
  expect(shown).toEqual([]);

  fireEvent.click(screen.getByRole("button", { name: "브라우저 알림 허용" }));
  await screen.findByText("브라우저 알림 켜짐");
  receiveCollectorDaemon("unresponsive", RECEIVED_AT);
  expect(shown).toEqual(["수집 현황판|수집 감독 데몬이 응답하지 않습니다"]);

  expect(screen.queryByRole("button", { name: /재시작|인계|멈춤|중지|시작|전환/ })).toBeNull();

  api.setStatus(statusPage("unresponsive", null));
  await client.invalidateQueries({ queryKey: ["collector", "status"] });
  await waitFor(() => expect(screen.getByRole("alert", { name: "감독 데몬" }).textContent).toContain("받은 상태 없음"));
  expect(screen.getByText("감독 데몬에서 받은 상태가 아직 없습니다.")).toBeTruthy();
  client.clear();
});

test("커버리지 실패, 모르는 판단 값, 범위 밖 received_at 및 오류 경계 복구가 안전하게 동작한다", async () => {
  serveCollector("allowed", statusPage("starting" as DaemonJudgment), {
    coverage: { status: 503, body: { error: { code: "collector_unavailable", message: "감독 데몬이 응답하지 않습니다", reason: null, retryAt: null, manualActionRequired: false } } },
  });
  const first = renderWithProviders(<CollectorBoard />);
  const band = await screen.findByRole("status", { name: "감독 데몬" });
  expect(band.textContent).toContain("starting");
  expect(band.getAttribute("data-judgment")).toBe("starting");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("커버리지를 받지 못했습니다");
  await waitFor(() => expect(screen.getByRole("region", { name: "디스크 사용량" }).textContent).toContain("800 GB"));
  first.client.clear();
  first.unmount();

  serveCollector("allowed", { ...statusPage("healthy"), received_at: 9e12 });
  const badTime = renderWithProviders(<CollectorBoard />);
  const unknownTimeBand = await screen.findByRole("status", { name: "감독 데몬" });
  expect(unknownTimeBand.textContent).toContain("마지막으로 받은 상태 알 수 없는 시각");
  expect(unknownTimeBand.textContent).not.toContain("NaN");
  badTime.client.clear();
  badTime.unmount();

  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const broken = { ...STATUS, keys: null } as unknown as CollectorStatus;
    const api = serveCollector("allowed", statusPage("healthy", broken));
    useSelectionStore.setState({ dialog: { kind: "system-settings", menu: "collector" } });
    const recovered = renderWithProviders(<SystemSettingsDialog />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("수집 현황판을 그리지 못했습니다"));

    api.setStatus(statusPage("healthy"));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("table", { name: "키별 상태" })).toBeTruthy();
    expect(screen.queryByText("수집 현황판을 그리지 못했습니다")).toBeNull();
    recovered.client.clear();
  } finally {
    consoleSpy.mockRestore();
  }
});
