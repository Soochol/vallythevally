import { dragGhostText, dragQuantity, dragSide } from "./orderRules";
import type { DragView } from "./useOrderDrag";

export function DragGhost({ view }: { view: DragView }) {
  return (
    <div className="od-ghost" data-testid="order-ghost" data-side={dragSide(view.source)} style={{ left: view.x, top: view.y }}>
      <b>{dragQuantity(view.source).toLocaleString("ko-KR")}</b> {dragGhostText(view.target, view.source)}
    </div>
  );
}
