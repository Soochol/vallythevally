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

interface Registration {
  command: SearchCommand;
  owner: symbol;
}

let registrations: readonly Registration[] = [];
let commands: readonly SearchCommand[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly Registration[]): void {
  registrations = next;
  commands = next.map(({ command }) => command);
  listeners.forEach((listener) => listener());
}

export function registerSearchCommands(additions: readonly SearchCommand[]): () => void {
  const owner = Symbol();
  const byId = new Map(additions.map((command) => [command.id, command]));
  publish([
    ...registrations.filter(({ command }) => !byId.has(command.id)),
    ...[...byId.values()].map((command) => ({ command, owner })),
  ]);
  return () => {
    const remaining = registrations.filter((entry) => entry.owner !== owner);
    if (remaining.length === registrations.length) return;
    publish(remaining);
  };
}

export const searchCommandsSnapshot = () => commands;
export function subscribeSearchCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
