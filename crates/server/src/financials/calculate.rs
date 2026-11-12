use std::collections::{BTreeMap, BTreeSet};

use domain::{KstDate, KstTime, TimeOfDay};

use crate::api::{FinancialBasis, FinancialInput, FinancialInputStatus, FinancialInputUsage, FinancialMetric, FinancialPeriod, FinancialPoint, FinancialProgress, FinancialReason, FinancialReportingPeriod, FinancialSeries, FinancialValueStatus, FinancialsPage, SymbolCode, UnixSeconds};
use super::{client::field, model::{Account, Basis, Collection, FactPeriod, Failure, Fetch, Report, Security, Snapshot, Statement, Verification}};

use FinancialReason as Reason;
use FinancialValueStatus as Status;

const METRICS: [FinancialMetric; 6] = [FinancialMetric::Revenue, FinancialMetric::OperatingIncome, FinancialMetric::OwnerRoe, FinancialMetric::InvestingCashFlow, FinancialMetric::Dps, FinancialMetric::DebtRatio];

#[derive(Clone, Copy)]
enum Concept { Revenue, OperatingIncome, OwnerProfit, InvestingCashFlow, Liabilities, Equity, OwnerEquity }

impl Concept {
    fn matches(self, account: &Account) -> bool {
        let id = field(&account.fields, "account_id");
        let section = field(&account.fields, "sj_div");
        let concept = id.strip_prefix("ifrs-full_").or_else(|| id.strip_prefix("ifrs_"));
        match self {
            Self::Revenue => matches!(section, "IS" | "CIS") && concept == Some("Revenue"),
            Self::OperatingIncome => matches!(section, "IS" | "CIS") && (id == "dart_OperatingIncomeLoss" || concept == Some("ProfitLossFromOperatingActivities")),
            Self::OwnerProfit => matches!(section, "IS" | "CIS") && concept == Some("ProfitLossAttributableToOwnersOfParent"),
            Self::InvestingCashFlow => section == "CF" && concept == Some("CashFlowsFromUsedInInvestingActivities"),
            Self::Liabilities => section == "BS" && concept == Some("Liabilities"),
            Self::Equity => section == "BS" && concept == Some("Equity"),
            Self::OwnerEquity => section == "BS" && concept == Some("EquityAttributableToOwnersOfParent"),
        }
    }
}

#[derive(Clone)]
struct Amount {
    value: f64,
    period: FactPeriod,
    basis: Basis,
    currency: String,
    inputs: Vec<FinancialInput>,
    snapshot_version: u64,
}

#[derive(Clone)]
struct Gap { status: Status, reason: Option<Reason>, period: Option<FactPeriod>, inputs: Vec<FinancialInput> }

type Calculation = Result<Amount, Gap>;

fn gap(reason: Reason, inputs: Vec<FinancialInput>) -> Gap { Gap { status: Status::NotCalculable, reason: Some(reason), period: None, inputs } }
fn failure(value: Option<Failure>) -> Option<String> { value.map(|v| serde_json::to_value(v).unwrap().as_str().unwrap().to_owned()) }
fn basis(value: Basis) -> FinancialBasis { match value { Basis::CFS => FinancialBasis::CFS, Basis::OFS => FinancialBasis::OFS } }
fn period(value: &FactPeriod) -> FinancialReportingPeriod {
    match value {
        FactPeriod::Instant { date } => FinancialReportingPeriod::Instant { date: date.clone() },
        FactPeriod::Duration { start, end } => FinancialReportingPeriod::Duration { start: start.clone(), end: end.clone() },
    }
}
fn date(value: &str) -> Option<KstDate> { KstDate::parse_yyyymmdd(&value.replace('-', "")).filter(|d| d.to_string() == value) }
fn end(value: &FactPeriod) -> &str { match value { FactPeriod::Instant { date } => date, FactPeriod::Duration { end, .. } => end } }
fn months(start: &str, end: &str, expected: i32) -> bool {
    let (Some(start), Some(end)) = (date(start), date(end)) else { return false; };
    let next = end.add_days(1);
    (next.year() - start.year()) * 12 + i32::from(next.month()) - i32::from(start.month()) == expected && next.day() == start.day()
}
fn duration_reason(start: &str, end: &str, expected: i32) -> Reason {
    let (Some(start), Some(end)) = (date(start), date(end)) else { return Reason::PeriodMismatch; };
    let next = end.add_days(1);
    let count = (next.year() - start.year()) * 12 + i32::from(next.month()) - i32::from(start.month());
    if count < expected { Reason::ShortPeriod } else { Reason::PeriodMismatch }
}
fn number(value: &str) -> Option<f64> { value.trim().replace(',', "").parse::<f64>().ok().filter(|v| v.is_finite()) }
fn disclosed(collection: &Collection, receipt: &str) -> Option<String> {
    collection.disclosures.iter().find(|row| field(row, "rcept_no") == receipt).and_then(|row| KstDate::parse_yyyymmdd(field(row, "rcept_dt"))).map(|d| d.to_string())
}

fn source<T>(report: &Report, fetch: &Fetch<T>, role: &str) -> FinancialInput {
    let status = if fetch.data.is_some() { FinancialInputStatus::Available } else if fetch.failure.is_some() { FinancialInputStatus::Failed } else if fetch.absent { FinancialInputStatus::Unpublished } else { FinancialInputStatus::Pending };
    FinancialInput { business_year: report.business_year, report_code: report.report_code.clone(), usage: FinancialInputUsage::Value, status, reason: None, role: role.into(), amount: None, period: None, verification_reason: None, basis: None, currency: None, receipt: None, disclosed_at: None, context_id: None, source_file: None, fields: BTreeMap::new(), checked_at: fetch.checked_at.map(UnixSeconds), last_success_at: fetch.last_success_at.map(UnixSeconds), failure: failure(fetch.failure), refresh_version: fetch.refresh_version }
}

fn statement_source(report: &Report, role: &str) -> FinancialInput {
    let mut input = source(report, &report.statement, role);
    input.failure = input.failure.or_else(|| report.statement.data.as_ref().and_then(|s| failure(s.source_failure)));
    input
}

fn account_source(report: &Report, collection: &Collection, account: &Account, cumulative: bool) -> FinancialInput {
    let mut input = statement_source(report, if cumulative { "thstrm_add_amount" } else { "thstrm_amount" });
    input.fields = account.fields.clone();
    input.amount = account.fields.get(&input.role).cloned();
    input.basis = report.statement.data.as_ref().map(|s| basis(s.basis));
    input.currency = account.fields.get("currency").cloned();
    input.receipt = account.fields.get("rcept_no").cloned();
    input.disclosed_at = input.receipt.as_deref().and_then(|r| disclosed(collection, r));
    let verification = if cumulative { &account.cumulative_period } else { &account.current_period };
    match verification {
        Verification::Verified { period: p, context_id, source_file, .. } => { input.period = Some(period(p)); input.context_id = Some(context_id.clone()); input.source_file = Some(source_file.clone()); }
        Verification::Unverified(reason) => input.verification_reason = Some(reason.clone()),
    }
    input
}

fn statement(report: &Report) -> Result<&Statement, Gap> {
    report.statement.data.as_ref().ok_or_else(|| Gap { status: if report.statement.failure.is_some() { Status::Failed } else if report.statement.absent { Status::Unpublished } else { Status::Pending }, reason: None, period: None, inputs: vec![statement_source(report, "statement")] })
}

fn amount(report: &Report, collection: &Collection, concept: Concept, cumulative: bool) -> Calculation {
    let statement = statement(report)?;
    let accounts: Vec<_> = statement.accounts.iter().filter(|a| concept.matches(a)).collect();
    if accounts.is_empty() {
        let inputs = statement.accounts.iter().filter(|a| !field(&a.fields, "account_id").starts_with("ifrs_") && !field(&a.fields, "account_id").starts_with("ifrs-full_") && !field(&a.fields, "account_id").starts_with("dart_")).map(|a| account_source(report, collection, a, cumulative)).collect::<Vec<_>>();
        return Err(Gap { status: Status::MissingItem, reason: (!inputs.is_empty()).then_some(Reason::AccountMappingUnverified), period: None, inputs });
    }
    let inputs: Vec<_> = accounts.iter().map(|a| account_source(report, collection, a, cumulative)).collect();
    let mut values = Vec::new();
    for account in accounts {
        let verification = if cumulative { &account.cumulative_period } else { &account.current_period };
        let Verification::Verified { period, receipt, .. } = verification else {
            let mut error = gap(Reason::PeriodUnverified, inputs);
            if statement.source_failure.is_some() { error.status = Status::Failed; }
            return Err(error);
        };
        if receipt != field(&account.fields, "rcept_no") { return Err(gap(Reason::ReceiptMismatch, inputs)); }
        let Some(value) = number(field(&account.fields, if cumulative { "thstrm_add_amount" } else { "thstrm_amount" })) else { return Err(gap(Reason::AmountMissing, inputs)); };
        let currency = field(&account.fields, "currency");
        if currency.is_empty() { return Err(gap(Reason::CurrencyMismatch, inputs)); }
        values.push((value, period.clone(), currency.to_owned()));
    }
    if values.iter().any(|v| v != &values[0]) { return Err(gap(Reason::AmbiguousAccount, inputs)); }
    let (value, period, currency) = values.remove(0);
    Ok(Amount { value, period, basis: statement.basis, currency, inputs, snapshot_version: report.statement.snapshot_version() })
}

fn compatible(a: &Amount, b: &Amount) -> Option<Reason> {
    if a.basis != b.basis { Some(Reason::BasisChanged) } else if a.currency != b.currency { Some(Reason::CurrencyMismatch) } else if a.snapshot_version != b.snapshot_version { Some(Reason::RefreshIncomplete) } else { None }
}

fn with_inputs(mut error: Gap, mut inputs: Vec<FinancialInput>) -> Gap { inputs.append(&mut error.inputs); error.inputs = inputs; error }

fn comparison_gap(current: &Amount, previous: &Report, mut error: Gap) -> Gap {
    if error.inputs.is_empty() { error.inputs.push(statement_source(previous, "statement")); }
    let status = match error.status {
        Status::Available => FinancialInputStatus::Available,
        Status::Unpublished => FinancialInputStatus::Unpublished,
        Status::MissingItem => FinancialInputStatus::MissingItem,
        Status::Failed => FinancialInputStatus::Failed,
        Status::Pending => FinancialInputStatus::Pending,
        Status::NotCalculable | Status::Unsupported => FinancialInputStatus::NotCalculable,
    };
    for input in &mut error.inputs {
        input.usage = FinancialInputUsage::Comparison;
        input.status = status;
        input.reason = error.reason;
    }
    gap(Reason::MissingComparison, [current.inputs.clone(), error.inputs].concat())
}

fn quarter(report: &Report, collection: &Collection, concept: Concept) -> Calculation {
    let current = amount(report, collection, concept, false)?;
    let FactPeriod::Duration { start, end } = &current.period else { return Err(gap(Reason::PeriodMismatch, current.inputs)); };
    let expected = match report.report_code.as_str() { "11013" => 3, "11012" => 6, "11014" => 9, "11011" => 12, _ => return Err(gap(Reason::PeriodMismatch, current.inputs)) };
    if expected != 12 && months(start, end, 3) { return Ok(current); }
    if !months(start, end, expected) { return Err(gap(duration_reason(start, end, expected), current.inputs)); }
    let previous_code = match report.report_code.as_str() { "11012" => "11013", "11014" => "11012", "11011" => "11014", _ => return Ok(current) };
    let Some(previous) = collection.reports.values().find(|r| r.business_year == report.business_year && r.report_code == previous_code) else {
        let missing = Report { business_year: report.business_year, report_code: previous_code.into(), statement: Fetch::<Statement>::default(), dividends: Fetch::default() };
        let mut input = statement_source(&missing, "statement");
        input.usage = FinancialInputUsage::Comparison;
        input.status = FinancialInputStatus::MissingReport;
        return Err(gap(Reason::MissingComparison, [current.inputs, vec![input]].concat()));
    };
    let mut prior = amount(previous, collection, concept, true).or_else(|error| {
        if matches!(concept, Concept::InvestingCashFlow) { amount(previous, collection, concept, false) } else { Err(error) }
    }).map_err(|e| comparison_gap(&current, previous, e))?;
    for input in &mut prior.inputs { input.usage = FinancialInputUsage::Comparison; }
    let mut inputs = current.inputs.clone();
    inputs.extend(prior.inputs.clone());
    if let Some(reason) = compatible(&current, &prior) { return Err(gap(reason, inputs)); }
    let FactPeriod::Duration { start: previous_start, end: previous_end } = &prior.period else { return Err(gap(Reason::PeriodMismatch, inputs)); };
    if previous_start != start || !months(previous_start, previous_end, expected - 3) { return Err(gap(Reason::PeriodMismatch, inputs)); }
    let quarter_start = date(previous_end).unwrap().add_days(1).to_string();
    if !months(&quarter_start, end, 3) { return Err(gap(Reason::PeriodMismatch, inputs)); }
    Ok(Amount { value: current.value - prior.value, period: FactPeriod::Duration { start: quarter_start, end: end.clone() }, inputs, ..current })
}

fn annual(report: &Report, collection: &Collection, concept: Concept) -> Calculation {
    let value = amount(report, collection, concept, false)?;
    match &value.period {
        FactPeriod::Duration { start, end } if months(start, end, 12) => Ok(value),
        FactPeriod::Duration { start, end } => Err(gap(duration_reason(start, end, 12), value.inputs)),
        _ => Err(gap(Reason::PeriodMismatch, value.inputs)),
    }
}

struct ReportingPeriod { period: FactPeriod, inputs: Vec<FinancialInput> }

fn report_period(report: &Report, collection: &Collection) -> Result<ReportingPeriod, Gap> {
    let statement = statement(report)?;
    let concepts = [Concept::Revenue, Concept::OperatingIncome, Concept::OwnerProfit, Concept::InvestingCashFlow];
    let mut periods = BTreeMap::new();
    for account in statement.accounts.iter().filter(|a| concepts.into_iter().any(|c| c.matches(a))) {
        for (cumulative, verification) in [(false, &account.current_period), (true, &account.cumulative_period)] {
            if let Verification::Verified { period: FactPeriod::Duration { start, end }, receipt, .. } = verification
                && receipt == field(&account.fields, "rcept_no") {
                periods.entry((start.clone(), end.clone())).or_insert_with(|| {
                    let mut input = account_source(report, collection, account, cumulative);
                    input.usage = FinancialInputUsage::ReportingPeriod;
                    input
                });
            }
        }
    }
    let ends: BTreeSet<_> = periods.keys().map(|(_, end)| end).collect();
    if ends.len() != 1 { return Err(gap(Reason::PeriodUnverified, periods.into_values().collect())); }
    let ((start, end), input) = periods.into_iter().next().unwrap();
    Ok(ReportingPeriod { period: FactPeriod::Duration { start, end }, inputs: vec![input] })
}

fn instant(report: &Report, collection: &Collection, concept: Concept, at: &str) -> Calculation {
    let value = amount(report, collection, concept, false)?;
    if value.period != (FactPeriod::Instant { date: at.into() }) { return Err(gap(Reason::PeriodMismatch, value.inputs)); }
    Ok(value)
}

fn equity_at(collection: &Collection, at: &str) -> Calculation {
    let mut candidates = Vec::new();
    for report in collection.reports.values() {
        if let Ok(value) = instant(report, collection, Concept::OwnerEquity, at) { candidates.push(value); }
    }
    let Some(first) = candidates.first().cloned() else { return Err(gap(Reason::MissingComparison, Vec::new())); };
    if candidates.iter().any(|v| v.value != first.value || compatible(v, &first).is_some()) { return Err(gap(Reason::AmbiguousAccount, candidates.into_iter().flat_map(|v| v.inputs).collect())); }
    Ok(first)
}

fn roe(report: &Report, collection: &Collection, frequency: FinancialPeriod) -> Calculation {
    let mut profit = if frequency == FinancialPeriod::Q { quarter(report, collection, Concept::OwnerProfit)? } else { annual(report, collection, Concept::OwnerProfit)? };
    if frequency == FinancialPeriod::Q {
        for _ in 0..3 {
            let FactPeriod::Duration { start, .. } = &profit.period else { unreachable!() };
            let previous_end = date(start).unwrap().add_days(-1).to_string();
            let candidates: Vec<_> = collection.reports.values().filter_map(|r| quarter(r, collection, Concept::OwnerProfit).ok()).filter(|v| end(&v.period) == previous_end).collect();
            if candidates.len() != 1 { return Err(gap(Reason::MissingComparison, profit.inputs)); }
            let previous = candidates.into_iter().next().unwrap();
            if let Some(reason) = compatible(&profit, &previous) { return Err(gap(reason, [profit.inputs, previous.inputs].concat())); }
            let FactPeriod::Duration { start: prior_start, .. } = previous.period else { unreachable!() };
            let FactPeriod::Duration { start, .. } = &mut profit.period else { unreachable!() };
            *start = prior_start;
            profit.value += previous.value;
            profit.inputs.extend(previous.inputs);
        }
    }
    let FactPeriod::Duration { start, end } = &profit.period else { unreachable!() };
    if !months(start, end, 12) { return Err(gap(Reason::PeriodMismatch, profit.inputs)); }
    let beginning = date(start).unwrap().add_days(-1).to_string();
    let opening = equity_at(collection, &beginning).map_err(|e| with_inputs(e, profit.inputs.clone()))?;
    let closing = instant(report, collection, Concept::OwnerEquity, end).map_err(|e| with_inputs(e, [profit.inputs.clone(), opening.inputs.clone()].concat()))?;
    let inputs = [profit.inputs.clone(), opening.inputs.clone(), closing.inputs.clone()].concat();
    if let Some(reason) = compatible(&profit, &opening).or_else(|| compatible(&profit, &closing)) { return Err(gap(reason, inputs)); }
    let average = opening.value / 2.0 + closing.value / 2.0;
    if average <= 0.0 { return Err(gap(Reason::NonPositiveAverageEquity, inputs)); }
    Ok(Amount { value: profit.value / average * 100.0, inputs, ..profit })
}

fn debt(report: &Report, collection: &Collection) -> Calculation {
    let liabilities = amount(report, collection, Concept::Liabilities, false)?;
    let equity = amount(report, collection, Concept::Equity, false).map_err(|e| with_inputs(e, liabilities.inputs.clone()))?;
    let inputs = [liabilities.inputs.clone(), equity.inputs.clone()].concat();
    if !matches!(&liabilities.period, FactPeriod::Instant { .. }) || liabilities.period != equity.period { return Err(gap(Reason::PeriodMismatch, inputs)); }
    let receipt = liabilities.inputs.first().and_then(|i| i.receipt.as_ref());
    let reason = compatible(&liabilities, &equity)
        .or_else(|| inputs.iter().any(|i| i.receipt.as_ref() != receipt).then_some(Reason::ReceiptMismatch))
        .or_else(|| (equity.value <= 0.0).then_some(Reason::NonPositiveEquity));
    if let Some(reason) = reason { return Err(Gap { period: Some(liabilities.period.clone()), ..gap(reason, inputs) }); }
    Ok(Amount { value: liabilities.value / equity.value * 100.0, inputs, ..liabilities })
}

fn dps(report: &Report, collection: &Collection, security: &Security, frequency: FinancialPeriod) -> Calculation {
    if frequency == FinancialPeriod::Q { return Err(Gap { status: Status::Unsupported, reason: Some(Reason::AnnualOnly), period: None, inputs: Vec::new() }); }
    let Some(rows) = &report.dividends.data else {
        return Err(Gap { status: if report.dividends.failure.is_some() { Status::Failed } else if report.dividends.absent { Status::Unpublished } else { Status::Pending }, reason: None, period: None, inputs: vec![source(report, &report.dividends, "dividends")] });
    };
    let mut inputs = Vec::new();
    for row in rows.iter().filter(|r| field(&r.fields, "se") == "주당 현금배당금(원)") {
        let mut input = source(report, &report.dividends, "thstrm");
        input.amount = row.fields.get("thstrm").cloned();
        input.fields = row.fields.clone();
        input.currency = Some("KRW".into());
        input.receipt = row.fields.get("rcept_no").cloned();
        input.disclosed_at = input.receipt.as_deref().and_then(|r| disclosed(collection, r));
        input.period = row.settlement_date.as_ref().map(|date| FinancialReportingPeriod::Instant { date: date.clone() });
        input.verification_reason = row.period_reason.clone().or_else(|| row.share_class_reason.clone());
        inputs.push(input);
    }
    if security.share_class.is_none() || security.share_class_reason.is_some() { return Err(gap(Reason::ShareClassUnverified, inputs)); }
    let matched: Vec<_> = rows.iter().filter(|r| field(&r.fields, "se") == "주당 현금배당금(원)" && r.share_class == security.share_class && r.share_class_reason.is_none()).collect();
    if matched.is_empty() { return Err(Gap { status: Status::MissingItem, reason: Some(Reason::ShareClassUnverified), period: None, inputs }); }
    let reporting = report_period(report, collection).map_err(|e| with_inputs(e, inputs.clone()))?;
    inputs.extend(reporting.inputs);
    let reporting = reporting.period;
    if !matches!(&reporting, FactPeriod::Duration { start, end } if months(start, end, 12)) { return Err(gap(Reason::ShortPeriod, inputs)); }
    let mut values = Vec::new();
    for row in matched {
        if row.settlement_date.as_deref() != Some(end(&reporting)) { return Err(gap(Reason::PeriodMismatch, inputs)); }
        let Some(value) = number(field(&row.fields, "thstrm")) else { return Err(gap(Reason::AmountMissing, inputs)); };
        values.push(value);
    }
    if values.iter().any(|v| *v != values[0]) { return Err(gap(Reason::AmbiguousAccount, inputs)); }
    if report.dividends.snapshot_version() != report.statement.snapshot_version() { return Err(gap(Reason::RefreshIncomplete, inputs)); }
    Ok(Amount { value: values[0], period: reporting, basis: statement(report)?.basis, currency: "KRW".into(), inputs, snapshot_version: report.dividends.snapshot_version() })
}

fn bucket(value: &FactPeriod, frequency: FinancialPeriod) -> Option<UnixSeconds> {
    let date = date(end(value))?;
    let month = if frequency == FinancialPeriod::Y { 1 } else { (date.month() - 1) / 3 * 3 + 1 };
    let first = KstDate::new(date.year(), month, 1)?;
    Some(UnixSeconds(KstTime::from_kst_civil(first, TimeOfDay::MIDNIGHT).unix()))
}

fn point(report: &Report, collection: &Collection, frequency: FinancialPeriod, metric: FinancialMetric, result: Calculation) -> FinancialPoint {
    let mut point = FinancialPoint { business_year: report.business_year, report_code: report.report_code.clone(), status: Status::Available, reason: None, value: None, reported_value: None, period: None, price_bucket: None, basis: report.statement.data.as_ref().map(|s| basis(s.basis)), currency: None, inputs: Vec::new() };
    match result {
        Ok(value) => {
            point.period = Some(period(&value.period));
            point.price_bucket = bucket(&value.period, frequency);
            point.currency = Some(value.currency);
            point.basis = Some(basis(value.basis));
            point.inputs = value.inputs;
            if value.value.is_finite() { point.value = Some(value.value); point.reported_value = Some(value.value); }
            else { point.status = Status::NotCalculable; point.reason = Some(Reason::NonFiniteResult); }
        }
        Err(error) => {
            point.status = error.status; point.reason = error.reason; point.inputs = error.inputs;
            if let Some(reporting) = error.period { point.period = Some(period(&reporting)); point.price_bucket = bucket(&reporting, frequency); }
        }
    }
    if metric != FinancialMetric::DebtRatio && point.period.is_none() && let Ok(reporting) = report_period(report, collection) {
        point.period = Some(period(&reporting.period));
        point.price_bucket = bucket(&reporting.period, frequency);
    }
    point
}

pub fn page(symbol: &str, frequency: FinancialPeriod, snapshot: Snapshot) -> FinancialsPage {
    let collection = &snapshot.collection;
    let mut progress = FinancialProgress { total: 0, completed: 0, failed: 0, pending: 0 };
    for report in collection.working_reports().values() {
        let fetches = std::iter::once((report.statement.checked_at, report.statement.failure.or(report.statement.data.as_ref().and_then(|s| s.source_failure)), report.statement.snapshot_version())).chain((report.report_code == "11011").then_some((report.dividends.checked_at, report.dividends.failure, report.dividends.snapshot_version())));
        for (checked, failed, version) in fetches {
            progress.total += 1;
            if failed.is_some() { progress.failed += 1; }
            else if checked.is_none() || version < collection.refresh_version { progress.pending += 1; }
            else { progress.completed += 1; }
        }
    }
    let series = METRICS.into_iter().map(|metric| {
        let mut points: Vec<_> = collection.reports.values().filter(|r| frequency == FinancialPeriod::Q || r.report_code == "11011").map(|report| {
            let result = match metric {
                FinancialMetric::Revenue | FinancialMetric::OperatingIncome | FinancialMetric::InvestingCashFlow => {
                    let concept = match metric { FinancialMetric::Revenue => Concept::Revenue, FinancialMetric::OperatingIncome => Concept::OperatingIncome, _ => Concept::InvestingCashFlow };
                    if frequency == FinancialPeriod::Q { quarter(report, collection, concept) } else { annual(report, collection, concept) }
                }
                FinancialMetric::OwnerRoe => roe(report, collection, frequency),
                FinancialMetric::DebtRatio => debt(report, collection),
                FinancialMetric::Dps => snapshot.security.as_ref().map_or_else(|| Err(gap(Reason::ShareClassUnverified, Vec::new())), |s| dps(report, collection, s, frequency)),
            };
            point(report, collection, frequency, metric, result)
        }).collect();
        let mut counts = BTreeMap::new();
        for p in &points { if let Some(bucket) = p.price_bucket { *counts.entry(bucket).or_insert(0) += 1; } }
        for p in &mut points {
            if p.price_bucket.is_some_and(|b| counts[&b] > 1) && p.status != Status::Unsupported { p.value = None; p.status = Status::NotCalculable; p.reason = Some(Reason::PeriodOverlap); }
        }
        points.sort_by_key(|p| (p.price_bucket.is_none(), p.price_bucket, p.business_year, p.report_code.clone()));
        FinancialSeries { metric, points }
    }).collect();
    FinancialsPage { symbol: SymbolCode(symbol.into()), period: frequency, status: snapshot.status.into(), reason: snapshot.reason.map(str::to_owned), failure: failure(snapshot.failure), corp_code: snapshot.security.as_ref().map(|s| s.company.corp_code.clone()), fiscal_month: snapshot.security.as_ref().and_then(|s| s.company.fiscal_month), share_class: snapshot.security.as_ref().and_then(|s| s.share_class.clone()), share_class_reason: snapshot.security.as_ref().and_then(|s| s.share_class_reason.clone()), last_checked_at: collection.last_checked_at.map(UnixSeconds), last_attempt_at: collection.last_attempt_at.map(UnixSeconds), disclosure_failure: failure(collection.disclosure_failure), refresh_version: collection.refresh_version, disclosure_version: collection.disclosure_version, latest_corrections: true, progress, series }
}
