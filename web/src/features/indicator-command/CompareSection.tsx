import { useSymbolInfos } from "../../api/queries";
import { shownScale } from "../../chart/settings";
import { useCell, useLayoutStore, type Slot } from "../../stores/layout";
import { CloseIcon } from "../icons";
import { AXIS_LOCKED, pressScale, type AddButton } from "../indicator-dialog/compareForm";

export function CompareSection({ slot, button, canAdd, onAdd, className }: { slot: Slot; button: AddButton; canAdd: boolean; onAdd(): void; className: string }) {
  const settings = useCell(slot).chartSettings;
  const infos = useSymbolInfos(settings.compare);
  return <aside className={className}>
    <h3 className="text-m font-semibold">비교 종목 {settings.compare.length}/3</h3>
    <p className="text-s text-text-2">비교 종목을 넣으면 가격축이 % 변화로 바뀝니다. 모두 지우면 원래 축으로 돌아갑니다.</p>
    <button type="button" role="switch" aria-checked={shownScale(settings) === "percent"} disabled={settings.compare.length > 0} onClick={() => { const scale = pressScale(settings, "percent"); if (scale) useLayoutStore.getState().setScale(slot, scale); }} className="tb-btn border border-line disabled:opacity-50">가격축을 % 변화로</button>
    {settings.compare.length > 0 && <p className="text-xs text-text-3">{AXIS_LOCKED}</p>}
    <ul className="space-y-1">{settings.compare.map((code) => { const info = infos.find((info) => info.code === code); const name = info?.name ?? code; return <li key={code} className="flex items-center gap-2 text-s"><span className="min-w-0 flex-1 truncate">{name}</span><button type="button" className="icon-btn size-6" aria-label={`${name} 지우기`} onClick={() => useLayoutStore.getState().removeCompare(slot, code)}><CloseIcon size={14} /></button></li>; })}</ul>
    {button.reason && <p className="text-s text-text-2">{button.reason}</p>}
    <button type="button" className="btn-primary mt-auto disabled:opacity-50" disabled={!button.ok || !canAdd} onClick={onAdd}>{button.label}</button>
  </aside>;
}
