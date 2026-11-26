// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { KiwoomKeyAdd } from "../../api/generated/KiwoomKeyAdd";
import type { KiwoomKeyList } from "../../api/generated/KiwoomKeyList";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { receiveKiwoomLinkPush, useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useAccountStore } from "../../stores/account";
import { useSelectionStore } from "../../stores/selection";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { SetupWizard } from "../setup-wizard/SetupWizard";
import { TRIMMED_HELP } from "./KiwoomKeyFields";
import { SystemSettingsDialog } from "./SystemSettingsDialog";

const NO_KEY: KiwoomLinkStatus = {
  environment: "real",
  keySource: "none",
  appKeyTail: null,
  credentialId: null,
  registeredIp: null,
  atStart: null,
  state: "noKey",
  step: null,
  problem: null,
  retryAt: null,
  needsAcknowledgement: false,
  message: "키움 키가 없습니다",
  tokenExpiresAt: null,
  realtimeRegistered: null,
  symbolCount: null,
};

const ENV_STATUS: KiwoomLinkStatus = {
  ...NO_KEY,
  keySource: "env",
  appKeyTail: "ENV9",
  state: "disconnected",
  message: ".env에 있는 키를 읽었습니다",
};

beforeEach(() => {
  useSelectionStore.setState({ dialog: null, toasts: [], toast: null });
  useKiwoomLinkStore.setState({ status: null, kiwoom: null, source: null, pushes: 0, sourcePushes: 0 });
  useAccountStore.setState({
    status: {
      state: "signed_in",
      provider: "google",
      accountId: "user-1",
      signedInAt: 1700000000,
      sync: { state: "running", lastSuccessAt: 1700000000, pendingDocuments: 0, refusedDocuments: 0, lastError: null },
    },
  });
});

resetDomAfterEach();

test("SecretField 붙여넣기 및 blur 시 앞뒤 공백을 잘라내고 안내 문구를 토글하며 저장한다", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: vi.fn().mockResolvedValue("  PASTED-KEY-7788\n ") },
  });

  const saved: KiwoomKeyAdd[] = [];
  const list: KiwoomKeyList = {
    keys: [{ keyId: "k1", broker: "kiwoom", alias: "키움 1", market: true, source: "file", appKeyTail: "7788", link: { ...NO_KEY, keySource: "file", appKeyTail: "7788", state: "disconnected" }, kisAccount: null }],
    limit: 5,
    keyFileProblem: null,
  };
  useKiwoomLinkStore.getState().receiveSnapshot(NO_KEY, 0);
  stubFetch((req) => {
    if (req.pathname === "/api/collector/access") return { body: { access: "denied" } };
    if (req.pathname === "/api/system/kiwoom") return { body: NO_KEY };
    if (req.pathname === "/api/system/market-source") return { body: { broker: "kiwoom", keyId: null, alias: null, state: "noKey", problem: null, step: "idle", retryAt: null, features: [], feedBroker: null } };
    if (req.pathname === "/api/system/kiwoom/keys" && req.method === "POST") {
      saved.push(req.json() as KiwoomKeyAdd);
      return { body: list };
    }
    if (req.pathname === "/api/system/kiwoom/keys") return { body: { keys: [], limit: 5, activeMarketId: null, keyFileProblem: null } };
    if (req.pathname === "/api/system/kiwoom/usage") return { body: { lastMinuteStartedAt: 1700000000, totalRateLimited: 0, trs: [] } };
    if (req.pathname === "/api/system/orders") return { body: { state: "off", accountRef: null, accountTail: null, message: "", accounts: [] } };
    return { body: {} };
  });

  useSelectionStore.setState({ dialog: { kind: "system-settings", menu: "kiwoom" } });
  const { client } = renderWithProviders(<SystemSettingsDialog />);

  fireEvent.click(await screen.findByRole("button", { name: /^키움증권/ }));
  const appKey = await screen.findByLabelText("앱키");
  const secret = screen.getByLabelText("시크릿");
  fireEvent.click(screen.getAllByRole("button", { name: "붙여넣기" })[0]!);
  await waitFor(() => expect((appKey as HTMLInputElement).value).toBe("PASTED-KEY-7788"));
  expect(screen.getAllByText(TRIMMED_HELP)).toHaveLength(1);

  fireEvent.change(appKey, { target: { value: "PASTED-KEY-7789" } });
  expect(screen.queryByText(TRIMMED_HELP)).toBeNull();

  fireEvent.change(secret, { target: { value: "  SECRET-VAL-123  " } });
  fireEvent.blur(secret);
  expect((secret as HTMLInputElement).value).toBe("SECRET-VAL-123");
  expect(screen.getByText(TRIMMED_HELP)).toBeTruthy();

  fireEvent.submit(screen.getByRole("form", { name: "키 더하기" }));
  await waitFor(() => expect(saved).toEqual([{ alias: "키움 1", appKey: "PASTED-KEY-7789", appSecret: "SECRET-VAL-123" }]));
  client.clear();
});

test("SetupWizard 2단계에서 .env 키 푸시가 오면 읽기 전용으로 바뀌고 낡은 입력 폼이 남지 않는다", async () => {
  let link = NO_KEY;
  stubFetch((req) => {
    if (req.pathname === "/api/system/kiwoom") return { body: link };
    if (req.pathname === "/api/system/market-source") return { body: { activeMarketBroker: "kiwoom", kisSource: false, hasKiwoomKey: false, kiwoomMarketFeed: "none" } };
    return { body: {} };
  });

  const { client } = renderWithProviders(<SetupWizard />);
  await screen.findByText("키 준비 목록", {}, { timeout: 1000 }).catch(() => null);
  const checkbox = await screen.findByRole("checkbox", { name: /포털에 지금 공인 IP를 등록했습니다/ });
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "다음" }));

  await screen.findByLabelText("앱키");
  link = ENV_STATUS;
  await act(async () => { receiveKiwoomLinkPush(ENV_STATUS); });

  expect(await screen.findByText(".env에서 읽음 · 읽기 전용")).toBeTruthy();
  expect(screen.queryByLabelText("앱키")).toBeNull();
  expect(screen.queryByLabelText("시크릿")).toBeNull();
  expect(screen.getByText("••••••••••••ENV9")).toBeTruthy();
  client.clear();
});
