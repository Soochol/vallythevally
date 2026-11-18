import type { OrderCancelBatchInput } from "../../api/generated/OrderCancelBatchInput";
import type { OrderCancelInput } from "../../api/generated/OrderCancelInput";
import type { OrderCommand } from "../../api/generated/OrderCommand";
import type { OrderCommands } from "../../api/generated/OrderCommands";
import type { OrderModifyInput } from "../../api/generated/OrderModifyInput";
import type { OrderPlaceInput } from "../../api/generated/OrderPlaceInput";
import type { OrderReconciliation } from "../../api/generated/OrderReconciliation";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingOpenOrders } from "../../api/generated/TradingOpenOrders";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { getJson, sendJson } from "../../api/http";

const ORDER_HEADERS = { "X-Vally-Order": "1" };
const COMMANDS = "/api/trading/commands";

const write = <T>(path: string, body: unknown): Promise<T> => sendJson<T>("POST", path, JSON.stringify(body), { headers: ORDER_HEADERS });

export const placeOrder = (input: OrderPlaceInput) => write<OrderCommand>(`${COMMANDS}/place`, input);
export const modifyOrder = (input: OrderModifyInput) => write<OrderCommand>(`${COMMANDS}/modify`, input);
export const cancelOrder = (input: OrderCancelInput) => write<OrderCommand>(`${COMMANDS}/cancel`, input);
export const cancelOrdersAtPrice = (input: OrderCancelBatchInput) => write<OrderCommands>(`${COMMANDS}/cancel-batch`, input);
export const reconcileOrders = () => write<OrderReconciliation>(`${COMMANDS}/reconcile`, {});

export const fetchOpenOrders = (signal?: AbortSignal) => getJson<TradingOpenOrders>("/api/trading/open-orders", signal);
export const fetchCommands = (signal?: AbortSignal) => getJson<OrderCommands>(COMMANDS, signal);
export const fetchOrderable = (code: string, side: OrderSide, price: number, signal?: AbortSignal) =>
  getJson<TradingOrderable>(`/api/trading/orderable?code=${encodeURIComponent(code)}&side=${side}&price=${price}`, signal);
