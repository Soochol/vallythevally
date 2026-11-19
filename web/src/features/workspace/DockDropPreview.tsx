import { levelStepName, type DockPlan } from "./dockCommands";

export function DockDropPreview({ preview }: { preview: Exclude<DockPlan, { kind: "unchanged" }> }) {
  const { levels } = preview;
  return (
    <>
      {levels && <div data-dock-level-frame={preview.kind} className="dock-drop-level" style={{ left: levels.rect.x, top: levels.rect.y, width: levels.rect.w, height: levels.rect.h }} />}
      <div data-dock-preview={preview.kind} className="dock-drop-preview" style={{ left: preview.rect.x, top: preview.rect.y, width: preview.rect.w, height: preview.rect.h }}>
        <div className="dock-drop-caption">
          <span data-dock-preview-label>{preview.label}</span>
          {levels && levels.steps.length > 1 && (
            <ol className="dock-drop-steps" aria-label="놓을 단계">
              {levels.steps.map((step, index) => <li key={index} aria-current={index === levels.current ? "step" : undefined}>{levelStepName(step)}</li>)}
            </ol>
          )}
        </div>
      </div>
    </>
  );
}
