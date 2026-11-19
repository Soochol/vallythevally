import type { UseQueryResult } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { Market } from "../../api/generated/Market";
import type { MarketOverviewStreaksCard } from "../../api/generated/MarketOverviewStreaksCard";
import type { MarketOverviewStreak } from "../../api/generated/MarketOverviewStreak";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingRow } from "../../api/generated/RankingRow";
import { useMarketRanking, useMarketStreaks } from "../../api/marketOverview";
import { formatPrice } from "../../lib/format";
import { useSendSymbol } from "../pages/sendSymbol";
import { CardShell, Loaded, PartView } from "./CardPart";
import { formatCount, signedEok, signedRate, toneOf } from "./marketFormat";

export const STOCK_TABS = [
  { id: "value", label: "거래대금" },
  { id: "gainers", label: "상승" },
  { id: "losers", label: "하락" },
  { id: "foreign", label: "외국인 연속" },
  { id: "institution", label: "기관 연속" },
] as const;
export type StockTab = (typeof STOCK_TABS)[number]["id"];

const EXCLUDES = { etfEtn: true, preferred: false } as const;

export function rankingOf(tab: "value" | "gainers" | "losers", market: Market): Ranking {
  if (tab === "value") return { kind: "tradeAmount", market, venue: "combined", excludes: EXCLUDES, excludeManaged: false };
  return { kind: tab, market, venue: "combined", includeLimit: true, minTradeAmount: "any", excludes: EXCLUDES, excludeManaged: false };
}

function SymbolButton({ code, name }: { code: string; name: string }) {
  const send = useSendSymbol();
  return <button type="button" className="mk-stock-name" onClick={() => send({ code, name })}>{name}</button>;
}

const eokOfWon = (won: number): string => signedEok(Math.round(won / 1e8));

function RankingTable({ market, tab, enabled }: { market: Market; tab: "value" | "gainers" | "losers"; enabled: boolean }) {
  const query = useMarketRanking(rankingOf(tab, market), { enabled });
  return (
    <Loaded query={query} label="종목 순위">
      {(page) => (
        <StockTable head={["순위", "종목", "현재가", "등락률", tab === "value" ? "거래대금" : "거래량"]} empty={page.rows.length === 0}>
          {page.rows.map((row: RankingRow) => (
            <tr key={row.code} data-code={row.code}>
              <td className="mk-num">{row.rank}</td>
              <td><SymbolButton code={row.code} name={row.name} /></td>
              <td className="mk-num">{row.price === null ? "—" : formatPrice(row.price, false)}</td>
              <td className="mk-num" data-tone={row.changeRate === null ? "flat" : toneOf(row.changeRate)}>{row.changeRate === null ? "—" : signedRate(row.changeRate)}</td>
              <td className="mk-num">{row.figures.kind === "tradeAmount" ? eokOfWon(row.figures.tradeAmount) : "volume" in row.figures ? formatCount(Number(row.figures.volume)) : "—"}</td>
            </tr>
          ))}
        </StockTable>
      )}
    </Loaded>
  );
}

function StockTable({ head, empty, children }: { head: string[]; empty: boolean; children: ReactNode }) {
  if (empty) return <p className="mk-empty">순위가 비어 있습니다</p>;
  return (
    <div className="mk-table-wrap">
      <table className="mk-table">
        <thead>
          <tr>{head.map((label) => <th key={label}>{label}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function StreakRows({ rows }: { rows: readonly MarketOverviewStreak[] }) {
  return (
    <StockTable head={["종목", "연속", "순매매", "기간 등락률"]} empty={rows.length === 0}>
      {rows.map((row) => (
        <tr key={row.code} data-code={row.code}>
          <td><SymbolButton code={row.code} name={row.name} /></td>
          <td className="mk-num" data-tone={toneOf(Number(row.days))}>{Number(row.days) > 0 ? "+" : ""}{formatCount(Number(row.days))}일</td>
          <td className="mk-num" data-tone={toneOf(row.netEok)}>{signedEok(row.netEok)}</td>
          <td className="mk-num" data-tone={toneOf(row.periodChangeRate)}>{signedRate(row.periodChangeRate)}</td>
        </tr>
      ))}
    </StockTable>
  );
}

function StreakTable({ query, subject }: { query: UseQueryResult<MarketOverviewStreaksCard>; subject: "foreign" | "institution" }) {
  return (
    <Loaded query={query} label="연속 매매">
      {(card) => (
        <div className="mk-streaks">
          {([["순매수 연속", card.buying], ["순매도 연속", card.selling]] as const).map(([title, part]) => (
            <section key={title} aria-label={title}>
              <h3>{title}</h3>
              <PartView part={part}>{(board) => <StreakRows rows={board[subject]} />}</PartView>
            </section>
          ))}
        </div>
      )}
    </Loaded>
  );
}

export function StockTabs({ market, enabled }: { market: Market; enabled: boolean }) {
  const [tab, setTab] = useState<StockTab>("value");
  const streaks = useMarketStreaks(market, { enabled });
  return (
    <CardShell title="종목">
      <div role="tablist" aria-label="종목 보기" className="mk-tabs">
        {STOCK_TABS.map((entry) => (
          <button key={entry.id} type="button" role="tab" id={`mk-tab-${entry.id}`} aria-selected={tab === entry.id} aria-controls="mk-stock-panel" onClick={() => setTab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="mk-stock-panel" aria-labelledby={`mk-tab-${tab}`} className="mk-stock-panel">
        {tab === "foreign" || tab === "institution" ? <StreakTable query={streaks} subject={tab} /> : <RankingTable market={market} tab={tab} enabled={enabled} />}
      </div>
    </CardShell>
  );
}

