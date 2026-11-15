// Lightweight Charts 라이선스가 요구하는 표기다(frontend.md §5.7). 로고를 끈 대신 링크를 늘 보이게 둔다.
export const ATTRIBUTION_URL = "https://www.tradingview.com/";

type Props = { className?: string } & ({ text: string; icon?: never } | { icon: true; text?: never });

export function Attribution({ text, icon, className }: Props) {
  return (
    <a href={ATTRIBUTION_URL} target="_blank" rel="noopener" className={className} aria-label={icon ? "TradingView" : undefined} title={icon ? "TradingView" : undefined}>
      {icon ? <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
        <path d="M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
      </svg> : text}
    </a>
  );
}
