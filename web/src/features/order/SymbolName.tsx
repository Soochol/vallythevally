export type GoToSymbol = (target: { code: string; name: string }) => void;

export function SymbolName({ code, name, goTo }: { code: string; name: string; goTo: GoToSymbol }) {
  return <button type="button" className="od-name od-symbol" aria-label={`${name}로 이동`} onClick={() => goTo({ code, name })}>{name}</button>;
}
