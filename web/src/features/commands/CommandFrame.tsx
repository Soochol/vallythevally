import type { ComponentProps } from "react";
import { DialogFrame } from "../dialog/DialogParts";

export function CommandFrame({ width = "h-[500px] w-[min(700px,calc(100vw-32px))] max-md:h-[85dvh]", ...props }: Omit<ComponentProps<typeof DialogFrame>, "variant" | "width"> & { width?: string }) {
  return <DialogFrame {...props} width={width} variant="command" />;
}
