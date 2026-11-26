import { DensitySection } from "./DensitySection";
import { ReadOnlyMenuContent } from "./ReadOnlyMenuContent";
import { ThemeSection } from "./ThemeSection";

export function GeneralMenuContent() {
  return (
    <div className="flex flex-col gap-4">
      <ThemeSection />
      <DensitySection />
      <ReadOnlyMenuContent menu="general" />
    </div>
  );
}
