import { create } from "zustand";
import {
  createAutoOrder,
  deleteAutoOrder,
  fetchAutoOrders,
  setAutoOrdersMaster,
  updateAutoOrder,
} from "../api/autoOrders";
import type { AutoOrderEvent } from "../api/generated/AutoOrderEvent";
import type { AutoOrderRule } from "../api/generated/AutoOrderRule";
import type { AutoOrderUpsertInput } from "../api/generated/AutoOrderUpsertInput";

export interface AutoOrdersStore {
  loaded: boolean;
  masterEnabled: boolean;
  rules: readonly AutoOrderRule[];
  events: readonly AutoOrderEvent[];
  load(): Promise<void>;
  createRule(input: AutoOrderUpsertInput): Promise<AutoOrderRule>;
  updateRuleOptimistic(id: string, input: AutoOrderUpsertInput): Promise<AutoOrderRule>;
  removeRuleOptimistic(id: string): Promise<void>;
  toggleMaster(enabled: boolean): Promise<void>;
  applyUpdated(rule: AutoOrderRule): void;
  applyTriggered(rule: AutoOrderRule, event: AutoOrderEvent): void;
  applyRemoved(id: string): void;
  applyMasterChanged(enabled: boolean): void;
}

function upsertInList(list: readonly AutoOrderRule[], rule: AutoOrderRule): AutoOrderRule[] {
  const idx = list.findIndex((r) => r.id === rule.id);
  if (idx < 0) return [rule, ...list];
  const next = list.slice();
  next[idx] = rule;
  return next;
}

export function isActiveAutoOrder(rule: AutoOrderRule): boolean {
  return rule.state !== "completed" && rule.state !== "stopped";
}

export const useAutoOrdersStore = create<AutoOrdersStore>()((set, get) => ({
  loaded: false,
  masterEnabled: true,
  rules: [],
  events: [],
  async load() {
    try {
      const data = await fetchAutoOrders();
      set({ loaded: true, masterEnabled: data.masterEnabled, rules: data.rules, events: data.events });
    } catch {
      set({ loaded: true });
    }
  },
  async createRule(input) {
    const created = await createAutoOrder(input);
    set((s) => ({ rules: upsertInList(s.rules, created) }));
    return created;
  },
  async updateRuleOptimistic(id, input) {
    const prev = get().rules;
    const existing = prev.find((r) => r.id === id);
    if (existing) {
      const optimistic: AutoOrderRule = {
        ...existing,
        stopLossPrice: input.stopLossPrice,
        takeProfit1Price: input.takeProfit1Price ?? existing.takeProfit1Price,
        takeProfit2Price: input.takeProfit2Price,
        tp1Ratio: input.tp1Ratio ?? existing.tp1Ratio,
        breakevenOnTp1: input.breakevenOnTp1 ?? existing.breakevenOnTp1,
        trailingEnabled: input.trailingEnabled ?? existing.trailingEnabled,
        trailingPct: input.trailingPct ?? existing.trailingPct,
        orderType: input.orderType ?? existing.orderType,
        tickOffset: input.tickOffset ?? existing.tickOffset,
      };
      set({ rules: upsertInList(prev, optimistic) });
    }
    try {
      const saved = await updateAutoOrder(id, input);
      set((s) => ({ rules: upsertInList(s.rules, saved) }));
      return saved;
    } catch (error) {
      set({ rules: prev });
      throw error;
    }
  },
  async removeRuleOptimistic(id) {
    const prev = get().rules;
    set({ rules: prev.filter((r) => r.id !== id) });
    try {
      await deleteAutoOrder(id);
    } catch (error) {
      set({ rules: prev });
      throw error;
    }
  },
  async toggleMaster(enabled) {
    const prev = get().masterEnabled;
    set({ masterEnabled: enabled });
    try {
      const res = await setAutoOrdersMaster({ enabled });
      set({ masterEnabled: res.enabled });
    } catch (error) {
      set({ masterEnabled: prev });
      throw error;
    }
  },
  applyUpdated(rule) {
    set((s) => ({ rules: upsertInList(s.rules, rule) }));
  },
  applyTriggered(rule, event) {
    set((s) => ({
      rules: upsertInList(s.rules, rule),
      events: [event, ...s.events].slice(0, 100),
    }));
  },
  applyRemoved(id) {
    set((s) => ({ rules: s.rules.filter((r) => r.id !== id) }));
  },
  applyMasterChanged(enabled) {
    set({ masterEnabled: enabled });
  },
}));
