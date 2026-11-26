// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { marketSocket } from "../../stores/realtime";
import { windowId } from "../../layout/kinds";
import { useUiStore } from "../../stores/ui";
import { renderWithProviders } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import type { Draft } from "../indicator-dialog/indicatorForm";
import { KiwoomAccountList } from "../system-settings/KiwoomAccountList";
import { MOCK_KEY_NOTICE } from "../system-settings/KiwoomKeyForm";
import { MockBadge } from "../topbar/MockBadge";
import { OrderWindow } from "./OrderWindow";
import { DEFAULT_ORDER_SETTINGS } from "./orderSettings";
import { MOCK_KRX_ONLY_TEXT } from "./statusText";
import { ACCOUNT, BASE, CODE, openOrder, setupOrderEnv } from "./orderTestHarness";

afterEach(() => {
  marketSocket.stop();
});

resetDomAfterEach();

test("모의투자 환경 배지·탭 제목 접두·KRX 강제·설정 비활성·mock_krx_only 거절·키 입력 숨김을 검증한다", async () => {
  document.title = "vally";
  const env = setupOrderEnv({ environment: "mock" });
  useUiStore.setState((s) => ({
    ...s,
    prefs: { ...s.prefs, orderSettings: { ...DEFAULT_ORDER_SETTINGS, venue: "nxt" } },
  }));

  const { client, unmount } = renderWithProviders(
    <>
      <MockBadge />
      <OrderWindow id={windowId("order")} />
      <KiwoomAccountList onOpenIpHelp={() => {}} />
    </>,
  );

  await screen.findByTestId("price-ladder");
  expect(document.title.startsWith("[모의] ")).toBe(true);
  expect(screen.getByTestId("account-mock").textContent).toBe("모의투자");
  expect(screen.getByTestId("order-window").getAttribute("data-venue")).toBe("krx");
  expect((await screen.findByTestId("mock-key-notice")).textContent).toBe(MOCK_KEY_NOTICE);

  fireEvent.click(screen.getByTestId("order-settings-button"));
  const pop = await screen.findByTestId("order-settings");
  const routes = within(pop).getAllByRole("group", { name: "주문 경로" })[0]!;
  expect((within(routes).getByRole("button", { name: "SOR" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(routes).getByRole("button", { name: "NXT" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(routes).getByRole("button", { name: "KRX" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByTestId("order-route-note").textContent).toBe(MOCK_KRX_ONLY_TEXT);
  fireEvent.keyDown(window, { key: "Escape" });

  await waitFor(() => expect(screen.getByTestId("order-window").hasAttribute("data-writable")).toBe(true));
  fireEvent.dblClick(document.querySelector(`[data-order-cell][data-side="buy"][data-price="${BASE}"]`)!);
  await waitFor(() => expect(env.placedBodies()).toHaveLength(1));
  expect(env.placedBodies()[0]!.venue).toBe("krx");

  env.placeReply = { state: "rejected", reason: "mock_krx_only", orderNo: null };
  fireEvent.dblClick(document.querySelector(`[data-order-cell][data-side="buy"][data-price="${BASE}"]`)!);
  await waitFor(() => expect(screen.getByTestId("order-status").textContent).toContain("KRX"));

  client.clear();
  unmount();
  expect(document.title).toBe("vally");
});

test("미시 지표 설정(허수 취소·아이스버그 흡수·표기 방식)과 총잔량 띠 비율 막대 비노출을 검증한다", async () => {
  setupOrderEnv();

  function Probe() {
    const [draft, setDraft] = useState<Draft>({
      form: {
        kind: "quoteDepth",
        text: { source: "priceMax", topLevels: "", maxOpacity: "70", microLabelMode: "clean" },
        enabled: { aboveBars: false, showSpoof: false, showIceberg: false },
      },
      color: "ind-1",
      width: 2,
      placement: "price",
      barOpacity: 0.7,
    });
    return (
      <>
        <OrderWindow id={windowId("order")} />
        <IndicatorSettingsForm draft={draft} color="ind-1" errors={[]} onChange={setDraft} />
      </>
    );
  }

  const { client, container } = renderWithProviders(<Probe />);
  await screen.findByTestId("order-total-ask");
  expect(screen.getByTestId("order-total-bid")).toBeTruthy();
  expect(container.querySelectorAll(".mw-ratio")).toHaveLength(0);
  expect(screen.queryByTestId("order-ofi-bar")).toBeNull();

  const spoof = screen.getByRole("switch", { name: "허수 취소 표시" });
  const iceberg = screen.getByRole("switch", { name: "아이스버그 흡수 표시" });
  const modeGroup = screen.getByRole("group", { name: "미시 표기 방식" });
  expect(spoof.getAttribute("aria-checked")).toBe("false");
  expect(iceberg.getAttribute("aria-checked")).toBe("false");
  expect(within(modeGroup).getByRole("button", { name: "점 표기" }).getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(spoof);
  fireEvent.click(iceberg);
  fireEvent.click(within(modeGroup).getByRole("button", { name: "배지 표기" }));
  expect(spoof.getAttribute("aria-checked")).toBe("true");
  expect(iceberg.getAttribute("aria-checked")).toBe("true");
  expect(within(modeGroup).getByRole("button", { name: "배지 표기" }).getAttribute("aria-pressed")).toBe("true");
  client.clear();
});

test("미체결 패널 취소, 계좌번호 가리기 토글·실패 타이틀, 남은 매도가능 수량 채우기, 설정 프리셋·계좌 전환을 검증한다", async () => {
  const SECOND = "ref-k2";
  const env = setupOrderEnv({
    openOrders: [openOrder("0000001", "sell", BASE + 500, 50)],
    holdings: [{ code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: BASE, currentPrice: BASE, evaluationProfit: 0, profitRateCenti: 0 }],
    ordersStatus: {
      state: "on",
      accountRef: ACCOUNT,
      accountTail: "12",
      message: "켜짐",
      accounts: [
        { keyId: "k1", broker: "kiwoom", alias: "주계좌", market: true, state: "on", accountRef: ACCOUNT, accountTail: "12" },
        { keyId: "k2", broker: "kiwoom", alias: "보조", market: false, state: "on", accountRef: SECOND, accountTail: "34" },
      ],
    },
  });

  const { client } = renderWithProviders(<OrderWindow id={windowId("order")} />);
  await screen.findByTestId("price-ladder");
  await waitFor(() => expect(screen.getByTestId("order-window").hasAttribute("data-writable")).toBe(true));

  const buyQty = await screen.findByTestId("summary-quantity");
  await waitFor(() => expect(buyQty.textContent).toContain("남은 70"));
  fireEvent.click(buyQty);
  expect((screen.getByRole("textbox", { name: "수량" }) as HTMLInputElement).value).toBe("70");

  fireEvent.click(screen.getByTestId("account-tab-open"));
  const openRow = await screen.findByTestId("account-open-order");
  fireEvent.click(within(openRow).getByRole("button", { name: "취소" }));
  await waitFor(() => expect(env.api.callsTo("POST", "/api/trading/commands/cancel")).toHaveLength(1));

  fireEvent.click(screen.getByTestId("order-settings-button"));
  const settingsPop = await screen.findByTestId("order-settings");
  const maskCheck = within(settingsPop).getByRole("checkbox", { name: /계좌번호 가리기/ });
  fireEvent.click(maskCheck);
  await waitFor(() => expect(screen.getByTestId("account-label").textContent).toContain("1234-5678"));
  fireEvent.click(maskCheck);
  await waitFor(() => expect(screen.getByTestId("account-label").textContent).toContain("****-**12"));

  const rateCheck = within(settingsPop).getByRole("checkbox", { name: /등락률/ });
  fireEvent.click(rateCheck);
  expect(screen.getByTestId("order-window").hasAttribute("data-rate-hidden")).toBe(true);
  fireEvent.click(rateCheck);
  expect(screen.getByTestId("order-window").hasAttribute("data-rate-hidden")).toBe(false);

  const presetInputs = within(settingsPop).getAllByRole("textbox") as HTMLInputElement[];
  fireEvent.change(presetInputs[1]!, { target: { value: "750" } });
  fireEvent.keyDown(presetInputs[1]!, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("button", { name: "750만" })).toBeTruthy());

  fireEvent.click(screen.getByTestId("account-label"));
  const picker = await screen.findByTestId("account-menu");
  fireEvent.click(within(picker).getByRole("radio", { name: /34/ }));
  await waitFor(() => expect(env.api.calls.some((c) => c.url.searchParams.get("account") === SECOND)).toBe(true));
  client.clear();
});
