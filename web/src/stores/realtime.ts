import { create } from "zustand";
import { type Connection, MarketSocket, sameOriginWsUrl } from "../api/socket";

export const marketSocket = new MarketSocket({ url: () => sameOriginWsUrl(location) });

export const useRealtimeStore = create<{ connection: Connection }>()(() => ({ connection: { socket: "connecting" } }));

marketSocket.watch((connection) => useRealtimeStore.setState({ connection }));
