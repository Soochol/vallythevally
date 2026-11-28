import { useState } from "react";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore, type AddSection } from "../../stores/selection";
import { IndicatorAddPanel } from "./IndicatorAddPanel";

export function IndicatorAddWindow() {
  const cellId = useSelectionStore((s) => s.activeCell);
  const opened = useLayoutStore((s) => `${s.session}:${s.layout.id}`);
  const [section, setSection] = useState<AddSection>("indicators");
  return <IndicatorAddPanel key={`${opened}:${cellId}`} cellId={cellId} section={section} onSection={setSection} regionLabel="지표" />;
}
