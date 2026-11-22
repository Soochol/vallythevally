import { type DragEvent, useRef, useState } from "react";

export interface ReorderRow {
  draggable: boolean;
  "data-drop": "before" | "after" | undefined;
  onDragStart(event: DragEvent<HTMLElement>): void;
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
  onDragEnd(): void;
}

const lowerHalf = (event: DragEvent<HTMLElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2;
};

export function useReorder(onMove: (from: number, to: number) => void): (index: number) => ReorderRow {
  const dragged = useRef<number | null>(null);
  const [mark, setMark] = useState<{ index: number; after: boolean } | null>(null);
  const finish = () => {
    dragged.current = null;
    setMark(null);
  };
  return (index) => ({
    draggable: true,
    "data-drop": mark?.index === index ? (mark.after ? "after" : "before") : undefined,
    onDragStart: (event) => {
      dragged.current = index;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    },
    onDragOver: (event) => {
      if (dragged.current === null) return;
      event.preventDefault();
      const after = lowerHalf(event);
      if (mark?.index !== index || mark.after !== after) setMark({ index, after });
    },
    onDrop: (event) => {
      const from = dragged.current;
      if (from === null) return;
      event.preventDefault();
      const slot = index + (lowerHalf(event) ? 1 : 0);
      onMove(from, slot > from ? slot - 1 : slot);
      finish();
    },
    onDragEnd: finish,
  });
}
