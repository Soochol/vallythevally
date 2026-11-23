import type { RefObject } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { MAX_THEME_SYMBOLS } from "../../lib/heatmapThemes";
import { Menu, type MenuItem } from "../menu/Menu";
import type { ThemeChoice } from "./themeQuickEdit";

export interface TileMenuState {
  code: SymbolCode;
  kind: "actions" | "themes";
  x: number;
  y: number;
}

interface Props {
  name: string;
  current: ThemeChoice;
  themes: readonly ThemeChoice[];
  code: SymbolCode;
  menu: TileMenuState;
  root: RefObject<HTMLElement | null>;
  onSend(): void;
  onAddToWatchlist(): void;
  onShowThemes(): void;
  onBack(): void;
  onAdd(theme: ThemeChoice): void;
  onRemove(): void;
  onClose(): void;
}

export function TileMenu({ name, current, themes, code, menu, root, onSend, onAddToWatchlist, onShowThemes, onBack, onAdd, onRemove, onClose }: Props) {
  const others = themes.filter((theme) => theme.id !== current.id);
  const items: MenuItem[] = menu.kind === "actions"
    ? [
      { kind: "heading", label: name },
      { kind: "action", label: "차트로 보내기", onSelect: onSend },
      { kind: "action", label: "관심종목에 추가", onSelect: onAddToWatchlist },
      { kind: "separator" },
      { kind: "action", label: "다른 테마에 추가", hint: "▸", disabled: others.length === 0, onSelect: onShowThemes },
      { kind: "action", label: "이 테마에서 빼기", danger: true, onSelect: onRemove },
    ]
    : [
      { kind: "action", label: "‹ 뒤로", onSelect: onBack },
      { kind: "heading", label: "다른 테마에 추가" },
      ...others.map((theme): MenuItem => {
        const held = theme.symbols.includes(code);
        const full = theme.symbols.length >= MAX_THEME_SYMBOLS;
        return { kind: "action", label: theme.name, disabled: held || full, hint: held ? "이미 있음" : full ? "가득 참" : undefined, onSelect: () => onAdd(theme) };
      }),
    ];
  return <Menu key={menu.kind} label={`${name} ${menu.kind === "actions" ? "칸 동작" : "다른 테마에 추가"}`} root={root} style={{ left: menu.x, top: menu.y }} className="max-h-[60vh] overflow-auto" items={items} onClose={onClose} />;
}
