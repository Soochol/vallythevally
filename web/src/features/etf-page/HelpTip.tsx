export function HelpTip({ label, text }: { label: string; text: string }) {
  return <button type="button" className="etf-help" aria-label={label} title={text}>?</button>;
}
