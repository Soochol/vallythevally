import type { OrderCancelBatchInput } from "../../api/generated/OrderCancelBatchInput";
import type { OrderCancelInput } from "../../api/generated/OrderCancelInput";
import type { OrderCommand } from "../../api/generated/OrderCommand";
import type { OrderCommands } from "../../api/generated/OrderCommands";
import type { OrderModifyInput } from "../../api/generated/OrderModifyInput";
import type { OrderPlaceInput } from "../../api/generated/OrderPlaceInput";
import type { OrderReconciliation } from "../../api/generated/OrderReconciliation";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingAccountNumber } from "../../api/generated/TradingAccountNumber";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecutions } from "../../api/generated/TradingExecutions";
import type { TradingOpenOrders } from "../../api/generated/TradingOpenOrders";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { OrdersMargin } from "../../api/generated/OrdersMargin";
import { getJson, putJson, sendJson } from "../../api/http";

const ORDER_HEADERS = { "X-Vally-Order": "1" };
const COMMANDS = "/api/trading/commands";

const accountQuery = (account: string | null, lead = "?"): string => (account === null ? "" : `${lead}account=${encodeURIComponent(account)}`);

const write = <T>(path: string, body: unknown): Promise<T> => sendJson<T>("POST", path, JSON.stringify(body), { headers: ORDER_HEADERS });

export const placeOrder = (input: OrderPlaceInput) => write<OrderCommand>(`${COMMANDS}/place`, input);
export const modifyOrder = (input: OrderModifyInput) => write<OrderCommand>(`${COMMANDS}/modify`, input);
export const cancelOrder = (input: OrderCancelInput) => write<OrderCommand>(`${COMMANDS}/cancel`, input);
export const cancelOrdersAtPrice = (input: OrderCancelBatchInput) => write<OrderCommands>(`${COMMANDS}/cancel-batch`, input);
export const reconcileOrders = (account: string | null) => write<OrderReconciliation>(`${COMMANDS}/reconcile${accountQuery(account)}`, {});

export const fetchOpenOrders = (account: string | null, signal?: AbortSignal) => getJson<TradingOpenOrders>(`/api/trading/open-orders${accountQuery(account)}`, signal);
export const fetchCommands = (account: string | null, signal?: AbortSignal) => getJson<OrderCommands>(`${COMMANDS}${accountQuery(account)}`, signal);
export const fetchOrderable = (account: string | null, code: string, side: OrderSide, price: number, signal?: AbortSignal) =>
  getJson<TradingOrderable>(`/api/trading/orderable?code=${encodeURIComponent(code)}&side=${side}&price=${price}${accountQuery(account, "&")}`, signal);
export const fetchBalance = (account: string | null, signal?: AbortSignal) => getJson<TradingBalance>(`/api/trading/balance${accountQuery(account)}`, signal);
export const fetchExecutions = (account: string | null, signal?: AbortSignal) => getJson<TradingExecutions>(`/api/trading/executions${accountQuery(account)}`, signal);
export const fetchAccountNumber = (account: string | null, signal?: AbortSignal) => getJson<TradingAccountNumber>(`/api/trading/account-number${accountQuery(account)}`, signal);

export const putMarginPolicy = (policy: MarginPolicy, account: string | null) => putJson<OrdersMargin>("/api/system/orders/margin", account === null ? { policy } : { policy, account });
