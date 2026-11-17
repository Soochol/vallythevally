import { create } from "zustand";
import { type Connection, MarketSocket, sameOriginWsUrl } from "../api/socket";
import { fetchQuotes } from "../api/userData";
import { receiveAccountPush } from "./account";
import { receiveKiwoomLinkPush } from "./kiwoomLink";
import { QuoteBook } from "./quoteBook";
import { receiveSetupChanged } from "./setupChange";
import { useUiStore } from "./ui";

export const marketSocket = new MarketSocket({ url: () => sameOriginWsUrl(location), onKiwoomLink: receiveKiwoomLinkPush, onAccount: receiveAccountPush, onSetupChanged: receiveSetupChanged });

export const quoteBook = new QuoteBook({ socket: marketSocket, fetchQuotes });

quoteBook.setVenue(useUiStore.getState().prefs.venue);
useUiStore.subscribe((state) => quoteBook.setVenue(state.prefs.venue));

export const useRealtimeStore = create<{ connection: Connection }>()(() => ({ connection: { socket: "connecting" } }));

marketSocket.watch((connection) => useRealtimeStore.setState({ connection }));
