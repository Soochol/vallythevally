import { useStoreValue } from "../../lib/valueStore";
import { dragCancels, dragGhostText, dragQuantity, dragSide } from "./orderRules";
import type { OrderDrag } from "./useOrderDrag";

export function DragGhost({ drag }: { drag: OrderDrag }) {
  const view = useStoreValue(drag.views, (current) => current);
  if (view === null) return null;
  return (
    <div className="od-ghost" data-testid="order-ghost" data-side={dragSide(view.source)} data-cancel={dragCancels(view.target, view.source) ? "" : undefined} style={{ left: view.x, top: view.y }}>
      <b>{dragQuantity(view.source).toLocaleString("ko-KR")}</b> {dragGhostText(view.target, view.source)}
    </div>
  );
}
