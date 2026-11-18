import type { RefObject } from "react";
import { equalizeAll, equalizeRun } from "../../layout/dock/balance";
import { applyPreset } from "../../layout/dock/push";
import { presetLead, type SharePreset } from "../../layout/dock/stops";
import { layoutDock, wholePixels, type DockSpace, type GutterBox } from "../../layout/dock/geometry";
import type { DockPlacement } from "../../layout/placement";
import { useLayoutStore } from "../../stores/layout";
import { Menu, type MenuItem } from "../menu/Menu";

type Preset = { label: string; preset: SharePreset };

const PRESETS: Record<"row" | "column", Preset[]> = {
  row: [{ label: "반반", preset: "half" }, { label: "왼쪽 1/3", preset: "one-two" }, { label: "왼쪽 2/3", preset: "two-one" }, { label: "기본 비율", preset: "default" }],
  column: [{ label: "반반", preset: "half" }, { label: "위 1/3", preset: "one-two" }, { label: "위 2/3", preset: "two-one" }],
};

const LEAST_REASON = { row: "최소 폭 때문에 맞출 수 없습니다", column: "최소 높이 때문에 맞출 수 없습니다" };

const rectsOf = (placement: DockPlacement, space: DockSpace) => {
  const px = wholePixels(space);
  return JSON.stringify(layoutDock(placement.root, px.area, px.gap).groups.map(({ rect }) => rect));
};

export function DividerMenu({ box, dock, space, root, at, onClose }: { box: GutterBox; dock: DockPlacement; space: DockSpace; root: RefObject<HTMLElement | null>; at: { x: number; y: number }; onClose(): void }) {
  const canUndo = useLayoutStore((s) => s.steps.length > 0);
  const dir = box.node.dir;
  const current = dir === "row" ? box.rect.x - box.bounds.x : box.rect.y - box.bounds.y;
  const preset = ({ label, preset }: Preset): MenuItem => {
    const target = presetLead(dock, box.path, space, preset);
    const unchanged = target?.lead === current;
    const hint = unchanged ? undefined : target?.clamped !== false ? LEAST_REASON[dir] : undefined;
    return { kind: "action", label, disabled: unchanged || target === null || target.clamped, hint, onSelect: () => useLayoutStore.getState().setDock(applyPreset(dock, box.path, preset, space).dock) };
  };
  const apply = (next: DockPlacement) => {
    if (rectsOf(next, space) !== rectsOf(dock, space)) useLayoutStore.getState().setDock(next);
  };
  const items: MenuItem[] = [
    ...PRESETS[dir].map(preset),
    { kind: "separator" },
    { kind: "action", label: "같은 방향 고르게", onSelect: () => apply(equalizeRun(dock, box.path, space)) },
    { kind: "action", label: "모두 고르게", onSelect: () => apply(equalizeAll(dock, space)) },
    { kind: "separator" },
    { kind: "action", label: "배치 되돌리기", disabled: !canUndo, onSelect: () => useLayoutStore.getState().undoArrangement() },
  ];
  return <Menu label="경계 크기" root={root} items={items} style={{ left: at.x, top: at.y }} onClose={onClose} />;
}
