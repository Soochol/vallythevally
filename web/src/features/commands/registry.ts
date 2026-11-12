import type { QueryClient } from "@tanstack/react-query";
import type { Slot } from "../../stores/layout";

export interface CommandContext {
  slot: Slot;
  queryClient: QueryClient;
}

export interface SearchCommand {
  id: string;
  label: string;
  keywords?: string;
  shortcut?: string;
  run(context: CommandContext): void | Promise<void>;
}

let commands: readonly SearchCommand[] = [];
const listeners = new Set<() => void>();

export function registerSearchCommands(additions: readonly SearchCommand[]): () => void {
  commands = [...commands.filter((c) => !additions.some((a) => a.id === c.id)), ...additions];
  listeners.forEach((listener) => listener());
  return () => {
    commands = commands.filter((c) => !additions.includes(c));
    listeners.forEach((listener) => listener());
  };
}

export const searchCommandsSnapshot = () => commands;
export function subscribeSearchCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
