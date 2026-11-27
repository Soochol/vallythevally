use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use domain::SymbolKind;
use sqlx::Row;
use tokio::sync::{RwLock, broadcast};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_uid(prefix: &str) -> String {
    let seq = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{seq}")
}

use super::tick::tick_size;
use crate::api::{
    AutoOrderEvent, AutoOrderList, AutoOrderMasterState, AutoOrderRule, AutoOrderState,
    AutoOrderType, AutoOrderUpsertInput,
};
use crate::clock::Clock;
use crate::db::AppDb;

const BROADCAST_CAP: usize = 128;
const MAX_EVENTS: i64 = 100;

#[derive(Debug, Clone)]
pub enum AutoOrderBroadcast {
    Updated(AutoOrderRule),
    Triggered { rule: AutoOrderRule, event: AutoOrderEvent },
    Removed(String),
    MasterChanged(bool),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TickAction {
    None,
    TrailUpdated { new_sl: u64, hwm: u64 },
    ViHeld,
    TriggerTp1 { price: u64, quantity: u64, moved_breakeven: bool, command_id: String },
    TriggerTp2 { price: u64, quantity: u64, command_id: String },
    TriggerStopLoss { price: u64, quantity: u64, command_id: String },
}

struct EngineMemory {
    master_enabled: bool,
    rules: HashMap<String, AutoOrderRule>,
    vi_symbols: HashSet<String>,
}

pub struct AutoOrderEngine {
    db: AppDb,
    clock: Clock,
    mem: RwLock<EngineMemory>,
    tx: broadcast::Sender<AutoOrderBroadcast>,
}

pub fn snap_to_tick(price: u64, kind: SymbolKind) -> u64 {
    let clamped = price.max(1);
    let step = tick_size(clamped, kind);
    ((clamped + step / 2) / step) * step
}

pub fn execution_price(trigger_price: u64, order_type: AutoOrderType, tick_offset: i32, kind: SymbolKind) -> u64 {
    match order_type {
        AutoOrderType::Market => 0,
        AutoOrderType::Limit => snap_to_tick(trigger_price, kind),
        AutoOrderType::LimitOffset => {
            let step = tick_size(trigger_price.max(1), kind) as i64;
            let shifted = (trigger_price as i64).saturating_sub(step * i64::from(tick_offset.max(0)));
            snap_to_tick(shifted.max(1) as u64, kind)
        }
    }
}

pub fn evaluate_tick(rule: &mut AutoOrderRule, price: u64, vi_active: bool, kind: SymbolKind) -> TickAction {
    if matches!(rule.state, AutoOrderState::Paused | AutoOrderState::Completed | AutoOrderState::Stopped) {
        return TickAction::None;
    }
    if rule.remaining_quantity == 0 {
        rule.state = AutoOrderState::Completed;
        return TickAction::None;
    }

    let mut trail_changed = false;
    if rule.trailing_enabled && price > rule.high_water_mark {
        rule.high_water_mark = price;
        let candidate = snap_to_tick(((price as f64) * (1.0 - rule.trailing_pct / 100.0)).round() as u64, kind);
        if candidate > rule.stop_loss_price {
            rule.stop_loss_price = candidate;
            trail_changed = true;
        }
    }

    let hit_sl = price <= rule.stop_loss_price;
    let hit_tp1 = !rule.tp1_done && rule.take_profit_1_price.is_some_and(|tp1| price >= tp1);
    let hit_tp2 = price >= rule.take_profit_2_price;

    if hit_sl || hit_tp1 || hit_tp2 {
        if vi_active {
            if rule.state != AutoOrderState::ViHeld {
                rule.state = AutoOrderState::ViHeld;
                return TickAction::ViHeld;
            }
            return TickAction::None;
        }
    } else if rule.state == AutoOrderState::ViHeld {
        rule.state = if rule.tp1_done { AutoOrderState::Tp1Filled } else { AutoOrderState::Watching };
    }

    if hit_sl {
        let qty = rule.remaining_quantity;
        let command_id = next_uid(&format!("auto-sl-{}", rule.id));
        rule.remaining_quantity = 0;
        rule.state = AutoOrderState::Stopped;
        rule.command_id = Some(command_id.clone());
        return TickAction::TriggerStopLoss { price, quantity: qty, command_id };
    }

    if hit_tp2 {
        let qty = rule.remaining_quantity;
        let command_id = next_uid(&format!("auto-tp2-{}", rule.id));
        rule.remaining_quantity = 0;
        rule.tp1_done = true;
        rule.state = AutoOrderState::Completed;
        rule.command_id = Some(command_id.clone());
        return TickAction::TriggerTp2 { price, quantity: qty, command_id };
    }

    if hit_tp1 {
        let ratio = rule.tp1_ratio.clamp(1, 99);
        let qty = ((rule.remaining_quantity * u64::from(ratio)) / 100).max(1).min(rule.remaining_quantity);
        let command_id = next_uid(&format!("auto-tp1-{}", rule.id));
        rule.tp1_done = true;
        rule.remaining_quantity = rule.remaining_quantity.saturating_sub(qty);
        let mut moved_breakeven = false;
        if rule.breakeven_on_tp1 && rule.stop_loss_price < rule.entry_price {
            rule.stop_loss_price = snap_to_tick(rule.entry_price, kind);
            moved_breakeven = true;
        }
        rule.state = if rule.remaining_quantity == 0 { AutoOrderState::Completed } else { AutoOrderState::Tp1Filled };
        rule.command_id = Some(command_id.clone());
        return TickAction::TriggerTp1 { price, quantity: qty, moved_breakeven, command_id };
    }

    if trail_changed {
        return TickAction::TrailUpdated { new_sl: rule.stop_loss_price, hwm: rule.high_water_mark };
    }
    TickAction::None
}

impl AutoOrderEngine {
    pub fn new(db: AppDb, clock: Clock) -> Arc<Self> {
        let (tx, _) = broadcast::channel(BROADCAST_CAP);
        Arc::new(Self {
            db,
            clock,
            mem: RwLock::new(EngineMemory {
                master_enabled: true,
                rules: HashMap::new(),
                vi_symbols: HashSet::new(),
            }),
            tx,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AutoOrderBroadcast> {
        self.tx.subscribe()
    }

    pub async fn load_from_db(&self) -> Result<(), String> {
        let master_row = sqlx::query("SELECT master_enabled FROM auto_order_settings WHERE id = 1")
            .fetch_optional(self.db.read())
            .await
            .map_err(|e| e.to_string())?;
        let master_enabled = master_row.map(|r| r.get::<i64, _>("master_enabled") != 0).unwrap_or(true);
        let rows = sqlx::query(
            "SELECT id, symbol, name, account_ref, entry_price, quantity, remaining_quantity,
                    stop_loss_price, take_profit_1_price, take_profit_2_price, tp1_ratio, tp1_done,
                    breakeven_on_tp1, trailing_enabled, trailing_pct, high_water_mark, order_type,
                    tick_offset, state, command_id, updated_at
             FROM auto_order_rules",
        )
        .fetch_all(self.db.read())
        .await
        .map_err(|e| e.to_string())?;

        let mut mem = self.mem.write().await;
        mem.master_enabled = master_enabled;
        mem.rules.clear();
        for row in rows {
            let rule = row_to_rule(&row);
            mem.rules.insert(rule.id.clone(), rule);
        }
        Ok(())
    }

    pub async fn list(&self) -> Result<AutoOrderList, String> {
        let mem = self.mem.read().await;
        let mut rules: Vec<AutoOrderRule> = mem.rules.values().cloned().collect();
        rules.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
        let master_enabled = mem.master_enabled;
        drop(mem);

        let event_rows = sqlx::query(
            "SELECT id, rule_id, symbol, kind, message, price, quantity, created_at
             FROM auto_order_events ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .bind(MAX_EVENTS)
        .fetch_all(self.db.read())
        .await
        .map_err(|e| e.to_string())?;

        let events = event_rows
            .into_iter()
            .map(|r| AutoOrderEvent {
                id: r.get::<i64, _>("id"),
                rule_id: r.get("rule_id"),
                symbol: r.get("symbol"),
                kind: r.get("kind"),
                message: r.get("message"),
                price: r.get::<i64, _>("price") as u64,
                quantity: r.get::<i64, _>("quantity") as u64,
                created_at: r.get("created_at"),
            })
            .collect();

        Ok(AutoOrderList { master_enabled, rules, events })
    }

    pub async fn create(&self, input: AutoOrderUpsertInput) -> Result<AutoOrderRule, String> {
        validate_input(&input)?;
        let now = self.clock.now().unix();
        let id = next_uid(&format!("ao-{now}"));
        let rule = build_rule(id, input, now);
        self.persist_rule(&rule).await?;
        self.mem.write().await.rules.insert(rule.id.clone(), rule.clone());
        let _ = self.tx.send(AutoOrderBroadcast::Updated(rule.clone()));
        Ok(rule)
    }

    pub async fn update(&self, id: &str, input: AutoOrderUpsertInput) -> Result<AutoOrderRule, String> {
        validate_input(&input)?;
        let now = self.clock.now().unix();
        let mem = self.mem.write().await;
        let existing = mem.rules.get(id).ok_or_else(|| "규칙을 찾을 수 없습니다".to_string())?;
        if matches!(existing.state, AutoOrderState::Completed | AutoOrderState::Stopped) {
            return Err("이미 종료된 자동감시 규칙은 수정할 수 없습니다".to_string());
        }
        let mut next = build_rule(id.to_string(), input, now);
        next.tp1_done = existing.tp1_done;
        next.high_water_mark = existing.high_water_mark.max(next.entry_price);
        next.command_id = existing.command_id.clone();
        drop(mem);

        self.persist_rule(&next).await?;
        self.mem.write().await.rules.insert(next.id.clone(), next.clone());
        let _ = self.tx.send(AutoOrderBroadcast::Updated(next.clone()));
        Ok(next)
    }

    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let mut tx = self.db.begin_write().await.map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM auto_order_rules WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        self.mem.write().await.rules.remove(id);
        let _ = self.tx.send(AutoOrderBroadcast::Removed(id.to_string()));
        Ok(())
    }

    pub async fn set_master(&self, enabled: bool) -> Result<AutoOrderMasterState, String> {
        let mut tx = self.db.begin_write().await.map_err(|e| e.to_string())?;
        sqlx::query("UPDATE auto_order_settings SET master_enabled = ? WHERE id = 1")
            .bind(if enabled { 1_i64 } else { 0_i64 })
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        self.mem.write().await.master_enabled = enabled;
        let _ = self.tx.send(AutoOrderBroadcast::MasterChanged(enabled));
        Ok(AutoOrderMasterState { enabled })
    }

    pub async fn set_vi_state(&self, symbol: &str, active: bool) {
        let mut mem = self.mem.write().await;
        if active {
            mem.vi_symbols.insert(symbol.to_string());
        } else {
            mem.vi_symbols.remove(symbol);
        }
    }

    pub async fn reconcile_holdings(&self, holdings: &HashMap<String, u64>) -> Result<usize, String> {
        let now = self.clock.now().unix();
        let mut updated = Vec::new();
        {
            let mut mem = self.mem.write().await;
            for rule in mem.rules.values_mut() {
                if matches!(rule.state, AutoOrderState::Completed | AutoOrderState::Stopped) {
                    continue;
                }
                let held = holdings.get(&rule.symbol).copied().unwrap_or(0);
                if held == 0 {
                    rule.remaining_quantity = 0;
                    rule.state = AutoOrderState::Completed;
                    rule.updated_at = now;
                    updated.push(rule.clone());
                } else if held < rule.remaining_quantity {
                    rule.remaining_quantity = held;
                    rule.updated_at = now;
                    updated.push(rule.clone());
                }
            }
        }
        for rule in &updated {
            self.persist_rule(rule).await?;
            let _ = self.tx.send(AutoOrderBroadcast::Updated(rule.clone()));
        }
        Ok(updated.len())
    }

    pub async fn on_tick(&self, symbol: &str, price: u64, kind: SymbolKind) -> Vec<TickAction> {
        let now = self.clock.now().unix();
        let mut actions = Vec::new();
        let mut to_persist: Vec<(AutoOrderRule, Option<PendingEvent>)> = Vec::new();

        {
            let mut mem = self.mem.write().await;
            if !mem.master_enabled {
                return actions;
            }
            let vi_active = mem.vi_symbols.contains(symbol);
            for rule in mem.rules.values_mut().filter(|r| r.symbol == symbol) {
                let action = evaluate_tick(rule, price, vi_active, kind);
                if action == TickAction::None {
                    continue;
                }
                rule.updated_at = now;
                let event = match &action {
                    TickAction::TrailUpdated { new_sl, hwm } => Some(PendingEvent {
                        kind: "TRAIL",
                        message: format!("신고점 {hwm}원 갱신 → 트레일링 손절가 {new_sl}원 상향"),
                        price: *new_sl,
                        quantity: rule.remaining_quantity,
                    }),
                    TickAction::ViHeld => Some(PendingEvent {
                        kind: "VI_HOLD",
                        message: format!("VI 발동 중 현재가 {price}원 도달 → 주문 보류"),
                        price,
                        quantity: rule.remaining_quantity,
                    }),
                    TickAction::TriggerTp1 { price: p, quantity: q, moved_breakeven, .. } => Some(PendingEvent {
                        kind: "TP1_FILLED",
                        message: format!(
                            "1차 분할 익절 {q}주 ({p}원) 발동{}",
                            if *moved_breakeven { " · 손절가 본절 이동" } else { "" }
                        ),
                        price: *p,
                        quantity: *q,
                    }),
                    TickAction::TriggerTp2 { price: p, quantity: q, .. } => Some(PendingEvent {
                        kind: "TP2_COMPLETED",
                        message: format!("최종 익절 {q}주 ({p}원) 발동 · 손절 OCO 자동 해제"),
                        price: *p,
                        quantity: *q,
                    }),
                    TickAction::TriggerStopLoss { price: p, quantity: q, .. } => Some(PendingEvent {
                        kind: "STOP_LOSS",
                        message: format!("자동 손절 {q}주 ({p}원) 발동 · 익절 OCO 취소"),
                        price: *p,
                        quantity: *q,
                    }),
                    TickAction::None => None,
                };
                to_persist.push((rule.clone(), event));
                actions.push(action);
            }
        }

        for (rule, event_opt) in to_persist {
            let _ = self.persist_rule(&rule).await;
            if let Some(ev) = event_opt
                && let Ok(event) = self.insert_event(&rule.id, &rule.symbol, ev, now).await
            {
                let _ = self.tx.send(AutoOrderBroadcast::Triggered { rule, event });
                continue;
            }
            let _ = self.tx.send(AutoOrderBroadcast::Updated(rule));
        }

        actions
    }

    async fn persist_rule(&self, rule: &AutoOrderRule) -> Result<(), String> {
        let mut tx = self.db.begin_write().await.map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT INTO auto_order_rules (
                id, symbol, name, account_ref, entry_price, quantity, remaining_quantity,
                stop_loss_price, take_profit_1_price, take_profit_2_price, tp1_ratio, tp1_done,
                breakeven_on_tp1, trailing_enabled, trailing_pct, high_water_mark, order_type,
                tick_offset, state, command_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                symbol=excluded.symbol, name=excluded.name, account_ref=excluded.account_ref,
                entry_price=excluded.entry_price, quantity=excluded.quantity,
                remaining_quantity=excluded.remaining_quantity, stop_loss_price=excluded.stop_loss_price,
                take_profit_1_price=excluded.take_profit_1_price, take_profit_2_price=excluded.take_profit_2_price,
                tp1_ratio=excluded.tp1_ratio, tp1_done=excluded.tp1_done,
                breakeven_on_tp1=excluded.breakeven_on_tp1, trailing_enabled=excluded.trailing_enabled,
                trailing_pct=excluded.trailing_pct, high_water_mark=excluded.high_water_mark,
                order_type=excluded.order_type, tick_offset=excluded.tick_offset,
                state=excluded.state, command_id=excluded.command_id, updated_at=excluded.updated_at",
        )
        .bind(&rule.id)
        .bind(&rule.symbol)
        .bind(&rule.name)
        .bind(&rule.account_ref)
        .bind(rule.entry_price as i64)
        .bind(rule.quantity as i64)
        .bind(rule.remaining_quantity as i64)
        .bind(rule.stop_loss_price as i64)
        .bind(rule.take_profit_1_price.map(|v| v as i64))
        .bind(rule.take_profit_2_price as i64)
        .bind(i64::from(rule.tp1_ratio))
        .bind(if rule.tp1_done { 1_i64 } else { 0_i64 })
        .bind(if rule.breakeven_on_tp1 { 1_i64 } else { 0_i64 })
        .bind(if rule.trailing_enabled { 1_i64 } else { 0_i64 })
        .bind(rule.trailing_pct)
        .bind(rule.high_water_mark as i64)
        .bind(order_type_str(rule.order_type))
        .bind(i64::from(rule.tick_offset))
        .bind(state_str(rule.state))
        .bind(&rule.command_id)
        .bind(rule.updated_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn insert_event(&self, rule_id: &str, symbol: &str, ev: PendingEvent, created_at: i64) -> Result<AutoOrderEvent, String> {
        let mut tx = self.db.begin_write().await.map_err(|e| e.to_string())?;
        let res = sqlx::query(
            "INSERT INTO auto_order_events (rule_id, symbol, kind, message, price, quantity, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(rule_id)
        .bind(symbol)
        .bind(ev.kind)
        .bind(&ev.message)
        .bind(ev.price as i64)
        .bind(ev.quantity as i64)
        .bind(created_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;

        Ok(AutoOrderEvent {
            id: res.last_insert_rowid(),
            rule_id: rule_id.to_string(),
            symbol: symbol.to_string(),
            kind: ev.kind.to_string(),
            message: ev.message,
            price: ev.price,
            quantity: ev.quantity,
            created_at,
        })
    }
}

struct PendingEvent {
    kind: &'static str,
    message: String,
    price: u64,
    quantity: u64,
}

fn validate_input(input: &AutoOrderUpsertInput) -> Result<(), String> {
    if input.symbol.trim().is_empty() {
        return Err("종목코드가 비어 있습니다".to_string());
    }
    if input.quantity == 0 {
        return Err("수량은 1주 이상이어야 합니다".to_string());
    }
    if input.stop_loss_price == 0 || input.take_profit_2_price == 0 {
        return Err("손절가와 익절가는 0보다 커야 합니다".to_string());
    }
    if input.stop_loss_price >= input.take_profit_2_price {
        return Err("손절가는 익절가보다 낮아야 합니다".to_string());
    }
    Ok(())
}

fn build_rule(id: String, input: AutoOrderUpsertInput, now: i64) -> AutoOrderRule {
    let kind = SymbolKind::Common;
    let entry = snap_to_tick(input.entry_price, kind);
    let sl = snap_to_tick(input.stop_loss_price, kind);
    let tp1 = input.take_profit_1_price.map(|p| snap_to_tick(p, kind));
    let tp2 = snap_to_tick(input.take_profit_2_price, kind);
    AutoOrderRule {
        id,
        symbol: input.symbol,
        name: input.name,
        account_ref: input.account_ref.unwrap_or_default(),
        entry_price: entry,
        quantity: input.quantity,
        remaining_quantity: input.quantity,
        stop_loss_price: sl,
        take_profit_1_price: tp1,
        take_profit_2_price: tp2,
        tp1_ratio: input.tp1_ratio.unwrap_or(50).clamp(1, 99),
        tp1_done: false,
        breakeven_on_tp1: input.breakeven_on_tp1.unwrap_or(true),
        trailing_enabled: input.trailing_enabled.unwrap_or(false),
        trailing_pct: input.trailing_pct.unwrap_or(2.0).clamp(0.3, 30.0),
        high_water_mark: entry,
        order_type: input.order_type.unwrap_or(AutoOrderType::Market),
        tick_offset: input.tick_offset.unwrap_or(2).clamp(0, 10),
        state: if input.paused.unwrap_or(false) { AutoOrderState::Paused } else { AutoOrderState::Watching },
        command_id: None,
        updated_at: now,
    }
}

fn order_type_str(t: AutoOrderType) -> &'static str {
    match t {
        AutoOrderType::Market => "market",
        AutoOrderType::Limit => "limit",
        AutoOrderType::LimitOffset => "limit_offset",
    }
}

fn parse_order_type(s: &str) -> AutoOrderType {
    match s {
        "limit" => AutoOrderType::Limit,
        "limit_offset" => AutoOrderType::LimitOffset,
        _ => AutoOrderType::Market,
    }
}

fn state_str(s: AutoOrderState) -> &'static str {
    match s {
        AutoOrderState::Watching => "watching",
        AutoOrderState::Tp1Filled => "tp1_filled",
        AutoOrderState::ViHeld => "vi_held",
        AutoOrderState::Paused => "paused",
        AutoOrderState::Completed => "completed",
        AutoOrderState::Stopped => "stopped",
    }
}

fn parse_state(s: &str) -> AutoOrderState {
    match s {
        "tp1_filled" => AutoOrderState::Tp1Filled,
        "vi_held" => AutoOrderState::ViHeld,
        "paused" => AutoOrderState::Paused,
        "completed" => AutoOrderState::Completed,
        "stopped" => AutoOrderState::Stopped,
        _ => AutoOrderState::Watching,
    }
}

fn row_to_rule(r: &sqlx::sqlite::SqliteRow) -> AutoOrderRule {
    AutoOrderRule {
        id: r.get("id"),
        symbol: r.get("symbol"),
        name: r.get("name"),
        account_ref: r.get("account_ref"),
        entry_price: r.get::<i64, _>("entry_price") as u64,
        quantity: r.get::<i64, _>("quantity") as u64,
        remaining_quantity: r.get::<i64, _>("remaining_quantity") as u64,
        stop_loss_price: r.get::<i64, _>("stop_loss_price") as u64,
        take_profit_1_price: r.get::<Option<i64>, _>("take_profit_1_price").map(|v| v as u64),
        take_profit_2_price: r.get::<i64, _>("take_profit_2_price") as u64,
        tp1_ratio: r.get::<i64, _>("tp1_ratio") as u8,
        tp1_done: r.get::<i64, _>("tp1_done") != 0,
        breakeven_on_tp1: r.get::<i64, _>("breakeven_on_tp1") != 0,
        trailing_enabled: r.get::<i64, _>("trailing_enabled") != 0,
        trailing_pct: r.get("trailing_pct"),
        high_water_mark: r.get::<i64, _>("high_water_mark") as u64,
        order_type: parse_order_type(r.get("order_type")),
        tick_offset: r.get::<i64, _>("tick_offset") as i32,
        state: parse_state(r.get("state")),
        command_id: r.get("command_id"),
        updated_at: r.get("updated_at"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_rule() -> AutoOrderRule {
        AutoOrderRule {
            id: "r1".to_string(),
            symbol: "005930".to_string(),
            name: "삼성전자".to_string(),
            account_ref: "acc1".to_string(),
            entry_price: 60_000,
            quantity: 200,
            remaining_quantity: 200,
            stop_loss_price: 58_800,
            take_profit_1_price: Some(62_400),
            take_profit_2_price: 64_800,
            tp1_ratio: 50,
            tp1_done: false,
            breakeven_on_tp1: true,
            trailing_enabled: true,
            trailing_pct: 2.0,
            high_water_mark: 60_000,
            order_type: AutoOrderType::LimitOffset,
            tick_offset: 2,
            state: AutoOrderState::Watching,
            command_id: None,
            updated_at: 0,
        }
    }

    #[test]
    fn tp1_splits_quantity_and_moves_sl_to_breakeven() {
        let mut r = sample_rule();
        r.trailing_enabled = false;
        let action = evaluate_tick(&mut r, 62_400, false, SymbolKind::Common);
        assert!(matches!(action, TickAction::TriggerTp1 { quantity: 100, moved_breakeven: true, .. }));
        assert_eq!(r.remaining_quantity, 100);
        assert_eq!(r.stop_loss_price, 60_000);
        assert_eq!(r.state, AutoOrderState::Tp1Filled);
    }

    #[test]
    fn stop_loss_triggers_once_and_blocks_oco_duplicate() {
        let mut r = sample_rule();
        let first = evaluate_tick(&mut r, 58_800, false, SymbolKind::Common);
        assert!(matches!(first, TickAction::TriggerStopLoss { quantity: 200, .. }));
        assert_eq!(r.state, AutoOrderState::Stopped);
        assert_eq!(r.remaining_quantity, 0);
        let second = evaluate_tick(&mut r, 65_000, false, SymbolKind::Common);
        assert_eq!(second, TickAction::None);
    }

    #[test]
    fn vi_holds_execution_and_reevaluates_on_release() {
        let mut r = sample_rule();
        let held = evaluate_tick(&mut r, 58_500, true, SymbolKind::Common);
        assert_eq!(held, TickAction::ViHeld);
        assert_eq!(r.state, AutoOrderState::ViHeld);
        assert_eq!(r.remaining_quantity, 200);
        let released = evaluate_tick(&mut r, 58_500, false, SymbolKind::Common);
        assert!(matches!(released, TickAction::TriggerStopLoss { quantity: 200, .. }));
    }

    #[test]
    fn trailing_stop_ratchets_up_with_krx_tick_snap() {
        let mut r = sample_rule();
        let a1 = evaluate_tick(&mut r, 61_500, false, SymbolKind::Common);
        assert_eq!(a1, TickAction::TrailUpdated { new_sl: 60_300, hwm: 61_500 });
        let a2 = evaluate_tick(&mut r, 60_300, false, SymbolKind::Common);
        assert!(matches!(a2, TickAction::TriggerStopLoss { price: 60_300, quantity: 200, .. }));
    }

    #[test]
    fn limit_offset_snaps_to_krx_ticks() {
        assert_eq!(execution_price(60_000, AutoOrderType::LimitOffset, 2, SymbolKind::Common), 59_800);
        assert_eq!(execution_price(60_000, AutoOrderType::Market, 2, SymbolKind::Common), 0);
    }
}
