import type { RefObject } from "react";
import { Menu } from "./Menu";

interface Props<T extends string> {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChoose: (v: T) => void;
  onClose: (restoreFocus: boolean) => void;
  root: RefObject<HTMLElement | null>;
  className: string;
}

export function RadioMenu<T extends string>({ options, value, onChoose, ...rest }: Props<T>) {
  const items = options.map((o) => ({ kind: "radio" as const, label: o.label, checked: o.value === value, onSelect: () => onChoose(o.value) }));
  return <Menu items={items} {...rest} />;
}
