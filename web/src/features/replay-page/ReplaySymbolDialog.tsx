import { useEffect, useRef, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { useSymbolInfos, useSymbolSearch } from "../../api/queries";
import { isIndexCode } from "../../lib/symbol";
import { useUiStore } from "../../stores/ui";

interface Props {
  readonly open: boolean;
  readonly currentCode: SymbolCode;
  readonly onSelect: (code: SymbolCode) => void;
  readonly onClose: () => void;
}

export function ReplaySymbolDialog({ open, currentCode, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const recentCodes = useUiStore((s) => s.prefs.recentSymbols).filter((code) => !isIndexCode(code));
  const recentInfos = useSymbolInfos(recentCodes);
  const normalized = query.trim();
  const search = useSymbolSearch(normalized);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  if (!open) return null;

  const rows: readonly SymbolInfo[] = normalized === ""
    ? recentInfos
    : (search.data?.rows ?? []).filter((row) => !isIndexCode(row.code)).slice(0, 30);

  return (
    <div
      className="rp-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="rp-modal" role="dialog" aria-label="복기 종목 전환" data-testid="replay-symbol-dialog">
        <div className="rp-modal-head">
          <h2>복기 종목 전환</h2>
          <button type="button" className="rp-close-btn" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <div className="rp-modal-body">
          <input
            ref={inputRef}
            type="search"
            className="rp-sym-input"
            aria-label="종목 검색"
            placeholder="종목명 또는 코드 검색 (예: 삼성전자, 005930)"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "Enter" && rows[0]) {
                onSelect(rows[0].code);
                onClose();
              }
            }}
          />
          <div className="rp-sym-list" role="listbox" aria-label="종목 목록">
            {rows.length === 0 ? (
              <div className="rp-sym-empty">
                {normalized === "" ? "최근 본 종목이 없습니다. 종목명이나 코드를 입력해 주세요." : "일치하는 종목이 없습니다."}
              </div>
            ) : (
              rows.map((item) => (
                <button
                  key={item.code}
                  type="button"
                  role="option"
                  aria-selected={item.code === currentCode}
                  className="rp-sym-item"
                  onClick={() => {
                    onSelect(item.code);
                    onClose();
                  }}
                >
                  <span className="rp-sym-item-name">{item.name}</span>
                  <span className="rp-sym-item-code rp-mono">{item.code}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
