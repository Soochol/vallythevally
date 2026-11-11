use std::collections::BTreeMap;

use domain::KstDate;
use roxmltree::{Document, Node};

use super::client::{Row, field};
use super::model::{Account, Basis, FactPeriod, Verification};

const INSTANCE: &str = "http://www.xbrl.org/2003/instance";
const DIMENSIONS: &str = "http://xbrl.org/2006/xbrldi";

pub fn accounts(rows: Vec<Row>, basis: Basis, corp: &str, receipt: &str, files: &[(String, String)], reporting_month: Option<&str>) -> Vec<Account> {
    let documents: Vec<_> = files.iter().filter_map(|(name, xml)| Document::parse(xml).ok().map(|doc| (name.as_str(), doc))).collect();
    rows.into_iter().map(|fields| {
        let current_period = verify(&fields, "thstrm_amount", basis, corp, receipt, &documents, reporting_month);
        let cumulative_period = verify(&fields, "thstrm_add_amount", basis, corp, receipt, &documents, reporting_month);
        Account { fields, current_period, cumulative_period }
    }).collect()
}

fn unverified(reason: &str) -> Verification { Verification::Unverified(reason.into()) }

fn verify(row: &Row, amount_field: &str, basis: Basis, corp: &str, receipt: &str, files: &[(&str, Document<'_>)], reporting_month: Option<&str>) -> Verification {
    if field(row, "rcept_no") != receipt { return unverified("receipt_mismatch"); }
    let Some(amount) = decimal(field(row, amount_field)) else { return unverified("amount_missing"); };
    let Some((prefix, concept)) = field(row, "account_id").split_once('_') else { return unverified("nonstandard_account"); };
    let mut candidates = Vec::new();
    for (name, doc) in files {
        if !doc.root_element().has_tag_name((INSTANCE, "xbrl")) { continue; }
        if doc.descendants().any(|n| is_dart(n) && n.tag_name().name() == "DocumentReceiptNumber" && n.text() != Some(receipt)) { return unverified("receipt_mismatch"); }
        let Some(month) = reporting_month else { return unverified("report_period_anchor_missing"); };
        let contexts: BTreeMap<_, _> = doc.descendants().filter(|n| n.has_tag_name((INSTANCE, "context"))).filter_map(|n| n.attribute("id").map(|id| (id, n))).collect();
        for fact in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == concept && concept_namespace(*n, prefix)) {
            if fact.attribute(("http://www.w3.org/2001/XMLSchema-instance", "nil")) == Some("true") || fact.text().and_then(decimal) != Some(amount) { continue; }
            let Some(context) = fact.attribute("contextRef").and_then(|id| contexts.get(id).copied()) else { continue; };
            if !entity_matches(context, corp) || context_basis(context) != Some(basis) || !unit_matches(doc, fact, field(row, "currency")) { continue; }
            let Some(period) = period(context) else { continue; };
            let matches = match (&period, field(row, "sj_div")) {
                (FactPeriod::Instant { date }, "BS") => date.starts_with(month),
                (FactPeriod::Duration { start, end: actual_end }, "IS" | "CIS") => actual_end.starts_with(month) && (amount_field != "thstrm_amount" || field(row, "reprt_code") == "11011" || three_months(start, actual_end)),
                (FactPeriod::Duration { end: actual_end, .. }, "CF") => actual_end.starts_with(month),
                _ => false,
            };
            if matches {
                candidates.push((period, context.attribute("id").unwrap_or_default().to_owned(), (*name).to_owned()));
            }
        }
    }
    candidates.sort();
    candidates.dedup_by(|a, b| a.0 == b.0);
    if candidates.len() != 1 { return unverified(if candidates.is_empty() { "matching_context_missing" } else { "ambiguous_context" }); }
    let (period, context_id, source_file) = candidates.remove(0);
    Verification::Verified { period, context_id, source_file, receipt: receipt.into() }
}

fn is_dart(node: Node<'_, '_>) -> bool {
    node.is_element() && node.tag_name().namespace().is_some_and(|ns| ns.starts_with("http://dart.fss.or.kr/"))
}

fn concept_namespace(node: Node<'_, '_>, prefix: &str) -> bool {
    let namespace = node.tag_name().namespace().unwrap_or_default();
    match prefix {
        "ifrs" | "ifrs-full" => namespace.starts_with("http://xbrl.ifrs.org/taxonomy/") && namespace.ends_with("/ifrs-full"),
        "dart" => is_dart(node),
        _ => false,
    }
}

fn entity_matches(context: Node<'_, '_>, corp: &str) -> bool {
    let ids: Vec<_> = context.descendants().filter(|n| n.has_tag_name((INSTANCE, "identifier"))).collect();
    ids.len() == 1 && ids[0].text() == Some(corp) && ids[0].attribute("scheme").is_some_and(|s| s == "http://dart.fss.or.kr/ifrs/CIK")
}

fn context_basis(context: Node<'_, '_>) -> Option<Basis> {
    let members: Vec<_> = context.descendants().filter(|n| n.has_tag_name((DIMENSIONS, "explicitMember"))).collect();
    if members.len() != 1 || context.descendants().any(|n| n.has_tag_name((DIMENSIONS, "typedMember"))) { return None; }
    let member = members[0];
    let (axis_prefix, axis) = member.attribute("dimension")?.split_once(':')?;
    if axis != "ConsolidatedAndSeparateFinancialStatementsAxis" || !basis_namespace(member.lookup_namespace_uri(Some(axis_prefix))?) { return None; }
    let (prefix, name) = member.text()?.trim().split_once(':')?;
    if !basis_namespace(member.lookup_namespace_uri(Some(prefix))?) { return None; }
    match name {
        "ConsolidatedMember" | "ConsolidatedFinancialStatementsMember" => Some(Basis::CFS),
        "SeparateMember" | "SeparateFinancialStatementsMember" => Some(Basis::OFS),
        _ => None,
    }
}

fn basis_namespace(namespace: &str) -> bool {
    (namespace.starts_with("http://xbrl.ifrs.org/taxonomy/") && namespace.ends_with("/ifrs-full")) || namespace.starts_with("http://dart.fss.or.kr/")
}

fn unit_matches(doc: &Document<'_>, fact: Node<'_, '_>, currency: &str) -> bool {
    let Some(id) = fact.attribute("unitRef") else { return false; };
    let units: Vec<_> = doc.descendants().filter(|n| n.has_tag_name((INSTANCE, "unit")) && n.attribute("id") == Some(id)).collect();
    if units.len() != 1 || units[0].descendants().any(|n| n.has_tag_name((INSTANCE, "divide"))) { return false; }
    let measures: Vec<_> = units[0].descendants().filter(|n| n.has_tag_name((INSTANCE, "measure"))).collect();
    if measures.len() != 1 { return false; }
    let Some((prefix, code)) = measures[0].text().and_then(|s| s.split_once(':')) else { return false; };
    code == currency && measures[0].lookup_namespace_uri(Some(prefix)) == Some("http://www.xbrl.org/2003/iso4217")
}

fn period(context: Node<'_, '_>) -> Option<FactPeriod> {
    let get = |name| {
        let nodes: Vec<_> = context.descendants().filter(|n| n.has_tag_name((INSTANCE, name))).collect();
        (nodes.len() == 1).then(|| nodes[0].text()).flatten().filter(|s| date(s).is_some()).map(str::to_owned)
    };
    if let Some(date) = get("instant") { return Some(FactPeriod::Instant { date }); }
    let (start, end) = (get("startDate")?, get("endDate")?);
    (start <= end).then_some(FactPeriod::Duration { start, end })
}

fn date(value: &str) -> Option<KstDate> {
    if value.len() != 10 || value.as_bytes()[4] != b'-' || value.as_bytes()[7] != b'-' { return None; }
    KstDate::parse_yyyymmdd(&value.replace('-', ""))
}

fn three_months(start: &str, end: &str) -> bool {
    let (Some(start), Some(end)) = (date(start), date(end)) else { return false; };
    let next = end.add_days(1);
    let months = (next.year() - start.year()) * 12 + i32::from(next.month()) - i32::from(start.month());
    months == 3 && next.day() == start.day()
}

fn decimal(value: &str) -> Option<(i128, u32)> {
    let clean = value.trim().replace(',', "");
    let (integer, fraction) = clean.split_once('.').unwrap_or((&clean, ""));
    let fraction = fraction.trim_end_matches('0');
    let value = format!("{integer}{fraction}").parse().ok()?;
    Some((value, fraction.len() as u32))
}
