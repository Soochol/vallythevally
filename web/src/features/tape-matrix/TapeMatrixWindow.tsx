import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useSymbolInfo } from "../../api/queries";
import type { WindowId } from "../../layout/kinds";
import { formatPercent } from "../../lib/format";
import { useFeedLink } from "../../stores/kiwoomLink";
import { useVenue } from "../../stores/ui";
import { useBookFeed } from "../book/useBookFeed";
import { CloseIcon } from "../icons";
import { FeedConnectGate } from "../market-window/MarketWindowGate";
import { EmptyState } from "../overlay/State";
import { dropPendingOpen, openResult } from "../screener/resultActions";
import { Segmented } from "../ui/Segmented";
import "./tapeMatrix.css";

export type GridCols = "auto" | "2" | "3" | "4";

export interface TapeMatrixConfig {
  readonly cols: GridCols;
  readonly symbols: readonly SymbolCode[];
}

const DEFAULT_SYMBOLS: readonly SymbolCode[] = ["005930", "000660", "035420", "035720"];
const STORAGE_PREFIX = "vally:tape-matrix:";

export function loadTapeMatrixConfig(id: WindowId): TapeMatrixConfig {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${id}`);
    if (!raw) return { cols: "auto", symbols: DEFAULT_SYMBOLS };
    const parsed = JSON.parse(raw) as Partial<TapeMatrixConfig>;
    const cols: GridCols = parsed.cols === "2" || parsed.cols === "3" || parsed.cols === "4" || parsed.cols === "auto" ? parsed.cols : "auto";
    const symbols = Array.isArray(parsed.symbols)
      ? parsed.symbols.filter((s): s is SymbolCode => typeof s === "string" && /^\d{6}$/.test(s))
      : DEFAULT_SYMBOLS;
    return { cols, symbols };
  } catch {
    return { cols: "auto", symbols: DEFAULT_SYMBOLS };
  }
}

export function saveTapeMatrixConfig(id: WindowId, config: TapeMatrixConfig): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(config));
  } catch {
  }
}

export type TapeMatrixAddResult = "added" | "duplicate" | "invalid";

const tapeMatrixAdders = new Map<WindowId, (code: SymbolCode) => TapeMatrixAddResult>();

export function addSymbolToTapeMatrix(id: WindowId, code: SymbolCode): TapeMatrixAddResult {
  if (!/^\d{6}$/.test(code)) return "invalid";
  const adder = tapeMatrixAdders.get(id);
  if (adder) return adder(code);
  const config = loadTapeMatrixConfig(id);
  if (config.symbols.includes(code)) return "duplicate";
  saveTapeMatrixConfig(id, { ...config, symbols: [...config.symbols, code] });
  return "added";
}

export function priceToneClass(price: number, prevClose: number | null): string {
  if (prevClose === null || prevClose <= 0) return "";
  if (price > prevClose) return "tm-up";
  if (price < prevClose) return "tm-down";
  return "";
}

function TapeCard({
  code,
  index,
  total,
  windowId,
  onMove,
  onRemove,
}: {
  code: SymbolCode;
  index: number;
  total: number;
  windowId: WindowId;
  onMove: (from: number, to: number) => void;
  onRemove: (code: SymbolCode) => void;
}) {
  const queryClient = useQueryClient();
  const venue = useVenue();
  const info = useSymbolInfo(code).data;
  const feed = useBookFeed(code, venue, null);
  const view = feed.book.phase === "empty" ? null : feed.book.view;
  const asks = (view?.asks ?? []).slice(0, 3).reverse();
  const bids = (view?.bids ?? []).slice(0, 3);
  const maxQty = Math.max(
    1,
    ...asks.map((l) => l.quantity),
    ...bids.map((l) => l.quantity),
  );
  const lastPrice = feed.lastPrice;
  const prevClose = feed.previousClose;
  const rate = lastPrice !== null && prevClose !== null && prevClose > 0 ? ((lastPrice - prevClose) / prevClose) * 100 : null;
  const askTotal = view?.totalAsk ?? 0;
  const bidTotal = view?.totalBid ?? 0;
  const ratio = askTotal > 0 ? (bidTotal / askTotal) * 100 : null;

  return (
    <div className="tm-card" data-testid={`tape-card-${code}`}>
      <div className="tm-card-head">
        <button
          type="button"
          className="tm-card-title"
          onClick={() => void openResult(queryClient, code, windowId)}
          title={`${info?.name ?? code} (${code})`}
        >
          {info?.name ?? code}
        </button>
        <span className={`tm-card-price ${rate !== null && rate > 0 ? "tm-up" : rate !== null && rate < 0 ? "tm-down" : ""}`}>
          {lastPrice !== null ? lastPrice.toLocaleString("ko-KR") : "—"}
          {rate !== null ? ` (${formatPercent(rate)})` : ""}
        </span>
        <button type="button" className="tm-card-act" aria-label="앞으로 이동" disabled={index === 0} onClick={() => onMove(index, index - 1)}>‹</button>
        <button type="button" className="tm-card-act" aria-label="뒤로 이동" disabled={index === total - 1} onClick={() => onMove(index, index + 1)}>›</button>
        <button type="button" className="tm-card-act" aria-label={`${code} 제거`} onClick={() => onRemove(code)}><CloseIcon size={12} /></button>
      </div>
      {feed.rejected === "realtime_limit" && (
        <div className="tm-limit" data-testid={`tape-limit-${code}`}>실시간 슬롯 한도 초과로 갱신이 제한됩니다</div>
      )}
      <div className="tm-book">
        {asks.length === 0 && bids.length === 0 ? (
          <div className="tm-book-empty">호가 대기 중</div>
        ) : (
          <>
            {asks.map((level, i) => {
              const qty = level.quantity;
              const width = Math.round((qty / maxQty) * 100);
              return (
                <div key={`a-${i}`} className="tm-lvl">
                  <div className="tm-bar-wrap" style={{ justifyContent: "flex-end" }}>
                    <div className="tm-bar-ask" style={{ width: `${width}%` }} />
                    <span className="tm-qty">{qty > 0 ? qty.toLocaleString("ko-KR") : "—"}</span>
                  </div>
                  <span className={`tm-px ${priceToneClass(level.price, prevClose)}`}>{level.price.toLocaleString("ko-KR")}</span>
                  <span />
                </div>
              );
            })}
            {bids.map((level, i) => {
              const qty = level.quantity;
              const width = Math.round((qty / maxQty) * 100);
              return (
                <div key={`b-${i}`} className="tm-lvl">
                  <span />
                  <span className={`tm-px ${priceToneClass(level.price, prevClose)}`}>{level.price.toLocaleString("ko-KR")}</span>
                  <div className="tm-bar-wrap">
                    <div className="tm-bar-bid" style={{ width: `${width}%` }} />
                    <span className="tm-qty">{qty > 0 ? qty.toLocaleString("ko-KR") : "—"}</span>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
      <div className="tm-card-foot">
        <span>매수/매도비 {ratio !== null ? `${ratio.toFixed(0)}%` : "—"}</span>
        <span>총잔량 {bidTotal.toLocaleString("ko-KR")} / {askTotal.toLocaleString("ko-KR")}</span>
      </div>
    </div>
  );
}

const COL_PRESETS: readonly { readonly id: GridCols; readonly label: string }[] = [
  { id: "auto", label: "자동" },
  { id: "2", label: "2열" },
  { id: "3", label: "3열" },
  { id: "4", label: "4열" },
];

export function TapeMatrixWindow({ id }: { id: WindowId }) {
  const link = useFeedLink();
  const connected = link === null || link.state === "connected";
  const [config, setConfig] = useState<TapeMatrixConfig>(() => loadTapeMatrixConfig(id));
  const [draft, setDraft] = useState("");

  useEffect(() => {
    saveTapeMatrixConfig(id, config);
  }, [id, config]);

  useEffect(() => {
    tapeMatrixAdders.set(id, (code) => {
      let result: TapeMatrixAddResult = "added";
      setConfig((prev) => {
        if (prev.symbols.includes(code)) {
          result = "duplicate";
          return prev;
        }
        return { ...prev, symbols: [...prev.symbols, code] };
      });
      return result;
    });
    return () => {
      tapeMatrixAdders.delete(id);
    };
  }, [id]);

  useEffect(() => dropPendingOpen, []);

  const addSymbol = (event: FormEvent) => {
    event.preventDefault();
    const cleaned = draft.trim();
    if (!/^\d{6}$/.test(cleaned)) return;
    if (config.symbols.includes(cleaned)) {
      setDraft("");
      return;
    }
    setConfig((prev) => ({ ...prev, symbols: [...prev.symbols, cleaned] }));
    setDraft("");
  };

  const removeSymbol = (code: SymbolCode) => {
    setConfig((prev) => ({ ...prev, symbols: prev.symbols.filter((s) => s !== code) }));
  };

  const moveSymbol = (from: number, to: number) => {
    setConfig((prev) => {
      if (to < 0 || to >= prev.symbols.length) return prev;
      const next = [...prev.symbols];
      const [picked] = next.splice(from, 1);
      if (picked === undefined) return prev;
      next.splice(to, 0, picked);
      return { ...prev, symbols: next };
    });
  };

  return (
    <div className="tm-window" data-testid="tape-matrix-window">
      <div className="tm-head">
        <Segmented
          label="그리드 열 수"
          mode="pressed"
          size="xs"
          value={config.cols}
          options={COL_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
          onChange={(cols) => setConfig((prev) => ({ ...prev, cols }))}
        />
        <form className="tm-add-form" onSubmit={addSymbol}>
          <input
            type="text"
            className="tm-input"
            placeholder="종목코드 6자리"
            aria-label="종목코드 추가"
            value={draft}
            maxLength={6}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="tm-add-btn">추가</button>
        </form>
        <span className="tm-spacer" />
        <span className="tm-meta">{config.symbols.length}종목 동시 감시</span>
      </div>
      <div className="tm-body">
        {!connected ? (
          <FeedConnectGate message={link?.message} />
        ) : config.symbols.length === 0 ? (
          <EmptyState title="감시할 종목을 추가해 주세요" />
        ) : (
          <div className="tm-grid" data-cols={config.cols} data-testid="tape-matrix-grid">
            {config.symbols.map((code, index) => (
              <TapeCard
                key={code}
                code={code}
                index={index}
                total={config.symbols.length}
                windowId={id}
                onMove={moveSymbol}
                onRemove={removeSymbol}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
