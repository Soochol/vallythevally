import { create } from "zustand";
import { type Connection, MarketSocket, sameOriginWsUrl } from "../api/socket";

/** 탭 하나의 `/api/ws` 연결. `main.tsx`가 `start()` 한다. */
export const marketSocket = new MarketSocket({ url: () => sameOriginWsUrl(location) });

export const useRealtimeStore = create<{ connection: Connection }>()(() => ({ connection: { socket: "connecting" } }));

marketSocket.watch((connection) => useRealtimeStore.setState({ connection }));
