import type { Broker } from "../../api/generated/Broker";
import type { MarketSourceStatus } from "../../api/generated/MarketSourceStatus";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import type { KiwoomKeyList } from "../../api/generated/KiwoomKeyList";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { ConnectionTone } from "../status/connectionView";
import type { KiwoomKeyAdd } from "../../api/generated/KiwoomKeyAdd";
import type { KisAccountInput } from "../../api/generated/KisAccountInput";
import { BROKERS, brokerOrder, takesAccountNumber } from "./brokers";
import { formatRemaining, inUseElsewhere } from "./kiwoomPanel";
import { linkDotTone } from "./linkDot";
import { REMOVE_ORDERS_NOTE } from "./orderUse";

export const KEY_LIST_REFRESH_MS = 5000;

export function shortReason(link: KiwoomLinkStatus, now: number, broker: Broker = "kiwoom"): string | null {
  if (link.state === "connecting" && link.step === "issueInterval") return waiting("발급 간격 대기", link, now);
  if (link.state !== "failed") return null;
  if (inUseElsewhere(link, broker)) return "다른 프로그램이 사용 중";
  switch (link.problem) {
    case "authBlocked8050":
      return "8050 인증 차단";
    case "keyNeedsCheck":
      return "키 확인 필요";
    case "issueIntervalWait":
      return waiting("발급 간격 대기", link, now);
    case "authUncertain":
      return waiting("인증 확인 대기", link, now);
    case "network":
      return waiting(`${BROKERS[broker].shortName}에 닿지 못함`, link, now);
    case "tokenFileUnusable":
      return "토큰 파일 사용 불가";
    case "keyFileUnusable":
      return "키 파일 사용 불가";
    case "pathStopped":
    case null:
      return "멈춤";
    default: {
      const _exhaustive: never = link.problem;
      return _exhaustive;
    }
  }
}

function waiting(label: string, link: KiwoomLinkStatus, now: number): string {
  if (link.retryAt === null) return label;
  const remaining = Math.max(0, Math.ceil(link.retryAt - now));
  return remaining > 0 ? `${label} ${formatRemaining(remaining)}` : label;
}

export const brokersShown = (list: KiwoomKeyList): Broker[] => brokerOrder().filter((broker) => broker === "kiwoom" || brokerKeys(list, broker).length > 0);

export const hasKeyError = (key: KiwoomKey): boolean => key.link.state === "failed";

export function menuDotTone(market: KiwoomLinkStatus | null, keys: readonly KiwoomKey[] | undefined): ConnectionTone {
  const tone = linkDotTone(market);
  if (tone === "red" || tone === "amber") return tone;
  return keys?.some((key) => !key.market && hasKeyError(key)) ? "amber" : tone;
}

export const marketKeyOf = (keys: readonly KiwoomKey[]): KiwoomKey | undefined => keys.find((key) => key.market);

export function nextMarketKey(keys: readonly KiwoomKey[], removing: KiwoomKey): KiwoomKey | undefined {
  return keys.find((key) => key.keyId !== removing.keyId);
}

export function marketChangeText(alias: string, from: Broker | null = null, to: Broker | null = null): string {
  const base = `시세를 ‘${alias}’에서 받습니다. 열린 차트·호가·체결을 새로 받습니다. 주문 계좌는 바뀌지 않습니다`;
  const note = from !== null && to !== null && from !== to ? BROKERS[to].sourceNote : null;
  return note === null ? base : `${base}. ${note}`;
}

export function removeText(keys: readonly KiwoomKey[], removing: KiwoomKey, ordersInUse = false): string {
  const base = removeBaseText(keys, removing);
  return ordersInUse ? `${base}. ${REMOVE_ORDERS_NOTE}` : base;
}

function removeBaseText(keys: readonly KiwoomKey[], removing: KiwoomKey): string {
  if (!removing.market) return `‘${removing.alias}’ 키를 지웁니다`;
  const next = nextMarketKey(keys, removing);
  const switched = next && next.broker !== removing.broker ? BROKERS[next.broker].sourceNote : null;
  return next
    ? `‘${removing.alias}’는 시세 키입니다. 지우면 시세를 ‘${next.alias}’에서 받습니다${switched ? `. ${switched}` : ""}`
    : `‘${removing.alias}’는 시세 키입니다. 지우면 키가 없어 시세를 받지 못합니다`;
}

export function pickerLabel(key: KiwoomKey, now: number): string {
  const reason = shortReason(key.link, now, key.broker);
  const tail = key.appKeyTail ? ` · ••••${key.appKeyTail}` : "";
  return `${key.alias}${tail}${reason ? ` · ${reason}` : ` · ${linkStateText(key.link)}`}`;
}

export function linkStateText(link: KiwoomLinkStatus): string {
  switch (link.state) {
    case "noKey":
      return "키 없음";
    case "disconnected":
      return "연결 안 함";
    case "connecting":
      return "연결 중";
    case "connected":
      return "연결됨";
    case "failed":
      return "오류";
    default: {
      const _exhaustive: never = link.state;
      return _exhaustive;
    }
  }
}

export function addResult(link: KiwoomLinkStatus, now: number): { tone: "ok" | "wait" | "error"; text: string } {
  if (link.state === "connected") return { tone: "ok", text: "토큰 받음" };
  const reason = shortReason(link, now);
  if (link.state === "failed") return link.problem === "issueIntervalWait" || link.problem === "authUncertain" || link.problem === "network" ? { tone: "wait", text: `대기 · ${reason}` } : { tone: "error", text: `오류 · ${reason}` };
  if (link.state === "connecting") return { tone: "wait", text: reason ? `대기 · ${reason}` : "대기 · 연결하는 중입니다" };
  return { tone: "wait", text: `대기 · ${linkStateText(link)}` };
}

export type AddStep = "broker" | "input" | "confirm";

export const addSteps = (brokers: readonly Broker[] = brokerOrder()): readonly AddStep[] => (brokers.length > 1 ? ["broker", "input", "confirm"] : ["input", "confirm"]);

export const defaultAlias = (keys: readonly KiwoomKey[], broker: Broker): string => `${BROKERS[broker].shortName} ${keys.filter((key) => key.broker === broker).length + 1}`;

export const brokerKeys = (list: KiwoomKeyList, broker: Broker): KiwoomKey[] => list.keys.filter((key) => key.broker === broker);

export const atLimit = (list: KiwoomKeyList, broker: Broker): boolean => brokerKeys(list, broker).length >= list.limit;

export function addedKey(before: readonly KiwoomKey[], after: readonly KiwoomKey[]): KiwoomKey | undefined {
  const known = new Set(before.map((key) => key.keyId));
  return after.find((key) => !known.has(key.keyId));
}

export interface KeyEntry {
  alias: string;
  appKey: string;
  appSecret: string;
  accountNo: string;
  htsId: string;
  reveal: boolean;
}

export type KeyEntryEvent =
  | { type: "alias"; value: string }
  | { type: "appKey"; value: string }
  | { type: "appSecret"; value: string }
  | { type: "accountNo"; value: string }
  | { type: "htsId"; value: string }
  | { type: "toggleReveal" }
  | { type: "reset"; alias: string };

export const emptyEntry = (alias: string): KeyEntry => ({ alias, appKey: "", appSecret: "", accountNo: "", htsId: "", reveal: false });

export function keyEntryReducer(entry: KeyEntry, event: KeyEntryEvent): KeyEntry {
  switch (event.type) {
    case "alias":
      return { ...entry, alias: event.value };
    case "appKey":
      return { ...entry, appKey: event.value };
    case "appSecret":
      return { ...entry, appSecret: event.value };
    case "accountNo":
      return { ...entry, accountNo: event.value };
    case "htsId":
      return { ...entry, htsId: event.value };
    case "toggleReveal":
      return { ...entry, reveal: !entry.reveal };
    case "reset":
      return emptyEntry(event.alias);
  }
}

const filled = (value: string) => value.trim() !== "";

export const canAdd = (entry: KeyEntry, broker: Broker = "kiwoom"): boolean => filled(entry.appKey) && filled(entry.appSecret) && (!takesAccountNumber(broker) || filled(entry.accountNo));

export function addInput(entry: KeyEntry, broker: Broker): KiwoomKeyAdd {
  const base = { alias: entry.alias.trim(), appKey: entry.appKey.trim(), appSecret: entry.appSecret.trim() };
  if (broker === "kiwoom") return base;
  return { ...base, broker, ...(takesAccountNumber(broker) ? { accountNo: entry.accountNo.trim() } : {}), ...(takesAccountNumber(broker) && filled(entry.htsId) ? { htsId: entry.htsId.trim() } : {}) };
}

export function accountRequest(entry: KeyEntry): KisAccountInput | null {
  if (!filled(entry.accountNo)) return null;
  return filled(entry.htsId) ? { accountNo: entry.accountNo.trim(), htsId: entry.htsId.trim() } : { accountNo: entry.accountNo.trim() };
}

export type EditRequest = { alias: string | null; credentials: { appKey: string; appSecret: string } | null };

export function editRequest(entry: KeyEntry, current: KiwoomKey): EditRequest | null {
  const alias = entry.alias.trim();
  if (alias === "" || filled(entry.appKey) !== filled(entry.appSecret)) return null;
  const credentials = filled(entry.appKey) ? { appKey: entry.appKey.trim(), appSecret: entry.appSecret.trim() } : null;
  const renamed = alias !== current.alias ? alias : null;
  return renamed === null && credentials === null ? null : { alias: renamed, credentials };
}

export function feedLine(source: MarketSourceStatus | null, keys: readonly KiwoomKey[]): string | null {
  if (source === null) return null;
  const feed = source.feedBroker?.broker;
  if (feed === undefined) return "순위·시장 개요·투자자: 받을 연결이 없습니다";
  const alias = keys.find((key) => key.broker === feed && key.link.state === "connected")?.alias;
  return `순위·시장 개요·투자자: ${BROKERS[feed].shortName}${alias ? ` · ‘${alias}’` : ""}`;
}
