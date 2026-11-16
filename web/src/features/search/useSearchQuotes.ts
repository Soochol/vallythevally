import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchQuotes } from "../../api/userData";
import { useVenue } from "../../stores/ui";

export function useSearchQuotes(contents: string) {
  const list = useRef<HTMLUListElement>(null);
  const venue = useVenue();
  const [symbols, setSymbols] = useState("");
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout>;
    const measure = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const bounds = node.getBoundingClientRect();
        const codes = [...node.querySelectorAll<HTMLElement>("[data-symbol]")].flatMap((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom && row.dataset.symbol ? [row.dataset.symbol] : [];
        });
        setSymbols([...new Set(codes)].sort().join(","));
      }, 150);
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => { clearTimeout(timer); node.removeEventListener("scroll", measure); observer.disconnect(); };
  }, [contents]);
  useEffect(() => { setSymbols(""); }, [contents]);
  const quotes = useQuery({
    queryKey: ["search-quotes", symbols, venue],
    queryFn: ({ signal }) => fetchQuotes(symbols.split(","), venue, signal),
    enabled: symbols !== "",
    staleTime: 30_000,
    retry: false,
  });
  return { list, quotes, bySymbol: new Map(quotes.data?.map((q) => [q.symbol, q])) };
}
