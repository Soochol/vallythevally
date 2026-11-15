export interface LegendField {
  element: HTMLElement;
  alternatives: readonly string[];
}

export interface LegendProjection {
  root: HTMLElement;
  fields: readonly LegendField[];
}

export function reserveLegendFields(fields: readonly LegendField[]): void {
  const styles = fields.map(({ element }) => getComputedStyle(element));
  const probes = fields.map(({ element, alternatives }, i) => {
    const probe = document.createElement("span");
    probe.textContent = [...new Set(alternatives)].join("\n");
    const style = styles[i];
    if (style) Object.assign(probe.style, { font: style.font, letterSpacing: style.letterSpacing, fontFeatureSettings: style.fontFeatureSettings, fontVariantNumeric: style.fontVariantNumeric });
    Object.assign(probe.style, { position: "absolute", whiteSpace: "pre", width: "max-content", maxWidth: "none", height: "0px", overflow: "hidden" });
    element.append(probe);
    return probe;
  });
  const widths = probes.map((probe) => probe.getBoundingClientRect().width);
  fields.forEach(({ element, alternatives }, i) => {
    const style = styles[i];
    const chrome = style ? [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((sum, value) => sum + parseFloat(value), 0) : 0;
    element.textContent = alternatives[0] ?? "";
    element.hidden = alternatives.length === 0;
    Object.assign(element.style, { display: alternatives.length ? "inline-block" : "none", width: `${(widths[i] ?? 0) + chrome}px`, flexShrink: "0" });
  });
}
