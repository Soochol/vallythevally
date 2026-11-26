import { useEffect, useState } from "react";

export interface CanvasPalette {
  readonly bg: string;
  readonly surface: string;
  readonly line: string;
  readonly lineStrong: string;
  readonly text: string;
  readonly text2: string;
  readonly text3: string;
  readonly accent: string;
  readonly accentInk: string;
  readonly accentSoft: string;
  readonly up: string;
  readonly down: string;
  readonly upVol: string;
  readonly downVol: string;
  readonly upSoft: string;
  readonly downSoft: string;
  readonly warning: string;
  readonly warningSoft: string;
  readonly danger: string;
  readonly dangerSoft: string;
  readonly ind1: string;
  readonly seriesFill: string;
  readonly fontMono: string;
  readonly fontSans: string;
}

function cssVar(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

export function readCanvasPalette(): CanvasPalette {
  const style = getComputedStyle(document.documentElement);
  return {
    bg: cssVar(style, "--bg"),
    surface: cssVar(style, "--surface"),
    line: cssVar(style, "--line"),
    lineStrong: cssVar(style, "--line-strong"),
    text: cssVar(style, "--text"),
    text2: cssVar(style, "--text-2"),
    text3: cssVar(style, "--text-3"),
    accent: cssVar(style, "--accent"),
    accentInk: cssVar(style, "--accent-ink"),
    accentSoft: cssVar(style, "--accent-soft"),
    up: cssVar(style, "--up"),
    down: cssVar(style, "--down"),
    upVol: cssVar(style, "--up-vol"),
    downVol: cssVar(style, "--down-vol"),
    upSoft: cssVar(style, "--up-soft"),
    downSoft: cssVar(style, "--down-soft"),
    warning: cssVar(style, "--warning"),
    warningSoft: cssVar(style, "--warning-soft"),
    danger: cssVar(style, "--danger"),
    dangerSoft: cssVar(style, "--danger-soft"),
    ind1: cssVar(style, "--ind-1"),
    seriesFill: cssVar(style, "--series-fill"),
    fontMono: cssVar(style, "--font-mono"),
    fontSans: cssVar(style, "--font-sans"),
  };
}

export function useCanvasPalette(): CanvasPalette {
  const [palette, setPalette] = useState<CanvasPalette>(() => readCanvasPalette());
  useEffect(() => {
    const refresh = () => setPalette(readCanvasPalette());
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-style"] });
    return () => observer.disconnect();
  }, []);
  return palette;
}
