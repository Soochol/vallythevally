import { create } from "zustand";
import { type Connection, MarketSocket, sameOriginWsUrl } from "../api/socket";
import { fetchQuotes } from "../api/userData";
import { receiveCollectorDaemon } from "../features/collector-board/alerts";
import { receiveAccountPush } from "./account";
import { receiveKiwoomLinkPush, receiveMarketSourcePush } from "./kiwoomLink";
import { QuoteBook } from "./quoteBook";
import { receiveSetupChanged } from "./setupChange";
import { useUiStore } from "./ui";
import { ViBook } from "./viBook";
import { ViExpectedStore } from "./viExpectedStore";
import { WhaleBook } from "./whaleBook";

export const marketSocket = new MarketSocket({ url: () => sameOriginWsUrl(location), onKiwoomLink: receiveKiwoomLinkPush, onMarketSource: receiveMarketSourcePush, onAccount: receiveAccountPush, onSetupChanged: receiveSetupChanged, onCollectorDaemon: receiveCollectorDaemon });

export const quoteBook = new QuoteBook({ socket: marketSocket, fetchQuotes });
export const viBook = new ViBook(marketSocket);
export const viExpectedStore = new ViExpectedStore(marketSocket, viBook);
export const whaleBook = new WhaleBook(marketSocket);

quoteBook.setVenue(useUiStore.getState().prefs.venue);
useUiStore.subscribe((state) => quoteBook.setVenue(state.prefs.venue));

export const useRealtimeStore = create<{ connection: Connection }>()(() => ({ connection: { socket: "connecting" } }));

marketSocket.watch((connection) => useRealtimeStore.setState({ connection }));
