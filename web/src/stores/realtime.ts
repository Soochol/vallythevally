import { create } from "zustand";
import { type Connection, MarketSocket, sameOriginWsUrl } from "../api/socket";
import { fetchQuotes } from "../api/userData";
import { QuoteBook } from "./quoteBook";

export const marketSocket = new MarketSocket({ url: () => sameOriginWsUrl(location) });

export const quoteBook = new QuoteBook({ socket: marketSocket, fetchQuotes });

export const useRealtimeStore = create<{ connection: Connection }>()(() => ({ connection: { socket: "connecting" } }));

marketSocket.watch((connection) => useRealtimeStore.setState({ connection }));
