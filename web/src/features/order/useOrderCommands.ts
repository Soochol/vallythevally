import { useCallback, useMemo, useRef, useState } from "react";
import type { HighValueRequest } from "./HighValueConfirm";
import { createOrderCommands, type OrderCommandContext, type OrderCommands } from "./orderCommand";
import { pendingWrites } from "./pendingWrites";
import type { OrderWrites } from "./useOrderWrites";

export interface BoundOrderCommands extends OrderCommands {
  readonly confirm: HighValueRequest | null;
  readonly clearConfirm: () => void;
}

export function useOrderCommands(
  context: OrderCommandContext,
  writes: OrderWrites,
  onRememberEntry: (quantity: number, usedAt: number) => void,
  onClearBuyRatio: () => void,
  onDisableBookReplay: () => void,
): BoundOrderCommands {
  const [confirm, setConfirm] = useState<HighValueRequest | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const writesRef = useRef(writes);
  writesRef.current = writes;
  const rememberRef = useRef(onRememberEntry);
  rememberRef.current = onRememberEntry;
  const clearBuyRatioRef = useRef(onClearBuyRatio);
  clearBuyRatioRef.current = onClearBuyRatio;
  const disableBookReplayRef = useRef(onDisableBookReplay);
  disableBookReplayRef.current = onDisableBookReplay;

  const commands = useMemo(
    () =>
      createOrderCommands(() => contextRef.current, {
        place: (request) => writesRef.current.place(request),
        modifyAll: (orders, price) => writesRef.current.modifyAll(orders, price),
        cancelOne: (orderNo) => writesRef.current.cancelOne(orderNo),
        cancelAtPrice: (side, price) => writesRef.current.cancelAtPrice(side, price),
        say: (status) => writesRef.current.say(status),
        setConfirm: (request) => setConfirm(request),
        rememberEntry: (quantity, usedAt) => rememberRef.current(quantity, usedAt),
        clearBuyRatio: () => clearBuyRatioRef.current(),
        disableBookReplay: () => disableBookReplayRef.current(),
        readPending: () => pendingWrites.snapshot(),
        nowMs: () => Date.now(),
      }),
    [],
  );

  const clearConfirm = useCallback(() => setConfirm(null), []);
  return useMemo(() => ({ ...commands, confirm, clearConfirm }), [commands, confirm, clearConfirm]);
}
