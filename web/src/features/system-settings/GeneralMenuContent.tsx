import { DensitySection } from "./DensitySection";
import { ReadOnlyMenuContent } from "./ReadOnlyMenuContent";

export function GeneralMenuContent() {
  return (
    <div className="flex flex-col gap-4">
      <DensitySection />
      <ReadOnlyMenuContent menu="general" />
    </div>
  );
}
