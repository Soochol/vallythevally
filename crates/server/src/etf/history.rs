use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::Path;

use domain::{KstDate, StockCode};

use super::collect::{PDF_DIR, STORED_SCHEMA_VERSION, StoredPdf, pdf_dir};
use super::{EtfChangeKind, EtfChangePair, EtfChangeRow, EtfChanges};
use crate::api;

const UNCHANGED_LIMIT: f64 = 0.01;
const BOUNDARY_TOLERANCE: f64 = 1e-9;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Held {
    pub code: String,
    pub name: String,
    pub quantity: f64,
}

pub(super) type Collection = BTreeMap<KstDate, Vec<Held>>;

pub(super) async fn read_collection(dir: &Path, code: StockCode) -> Collection {
    let mut collection = Collection::new();
    let Ok(mut days) = tokio::fs::read_dir(dir.join(PDF_DIR)).await else {
        return collection;
    };
    while let Ok(Some(entry)) = days.next_entry().await {
        let Some(day) = entry.file_name().to_str().and_then(KstDate::parse_yyyymmdd) else { continue };
        let path = pdf_dir(dir, day).join(format!("{}.json", code.as_str()));
        let Ok(bytes) = tokio::fs::read(&path).await else { continue };
        match held_from_stored(&bytes, code, day) {
            Ok(held) => {
                collection.insert(day, held);
            }
            Err(reason) => tracing::warn!(file = %path.display(), %reason, "저장된 ETF 구성을 편입 변경에 쓰지 않습니다"),
        }
    }
    collection
}

fn held_from_stored(bytes: &[u8], code: StockCode, day: KstDate) -> Result<Vec<Held>, String> {
    let stored: StoredPdf = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if stored.schema_version != STORED_SCHEMA_VERSION || stored.code != code.as_str() || stored.as_of != day.to_string() {
        return Err("자료 버전·ETF 코드·기준일이 파일 위치와 다릅니다".into());
    }
    Ok(stored.holdings.into_iter().map(|h| Held { code: h.code, name: h.name, quantity: h.cu_quantity }).collect())
}

fn is_held(held: &Held) -> bool {
    held.quantity.is_finite() && held.quantity > 0.0
}

pub(super) fn median(mut values: Vec<f64>) -> Option<f64> {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    match values.len() {
        0 => None,
        len if len % 2 == 1 => Some(values[middle]),
        _ => Some((values[middle - 1] + values[middle]) / 2.0),
    }
}

fn kind_of(real_change: f64) -> EtfChangeKind {
    if real_change.abs() - UNCHANGED_LIMIT <= BOUNDARY_TOLERANCE {
        EtfChangeKind::Unchanged
    } else if real_change > 0.0 {
        EtfChangeKind::Increased
    } else {
        EtfChangeKind::Decreased
    }
}

fn kind_rank(kind: EtfChangeKind) -> u8 {
    match kind {
        EtfChangeKind::Added => 0,
        EtfChangeKind::Increased => 1,
        EtfChangeKind::Decreased => 2,
        EtfChangeKind::Removed => 3,
        EtfChangeKind::Unchanged => 4,
    }
}

pub(super) struct Comparison {
    pub common_scale: Option<f64>,
    pub rows: Vec<EtfChangeRow>,
}

pub(super) fn compare(before: &[Held], after: &[Held]) -> Comparison {
    let before: BTreeMap<&str, &Held> = before.iter().filter(|h| is_held(h)).map(|h| (h.code.as_str(), h)).collect();
    let after: BTreeMap<&str, &Held> = after.iter().filter(|h| is_held(h)).map(|h| (h.code.as_str(), h)).collect();
    let ratios: Vec<f64> = after.iter().filter_map(|(code, now)| before.get(code).map(|was| now.quantity / was.quantity)).collect();
    let common_scale = median(ratios);
    let mut rows: Vec<EtfChangeRow> = Vec::new();
    for (code, now) in &after {
        rows.push(match before.get(code) {
            None => EtfChangeRow { code: (*code).into(), name: now.name.clone(), before_quantity: None, after_quantity: Some(now.quantity), real_change: None, kind: EtfChangeKind::Added },
            Some(was) => {
                let scale = common_scale.expect("공통 종목이 있으면 배율이 있다");
                let real_change = now.quantity / was.quantity / scale - 1.0;
                EtfChangeRow { code: (*code).into(), name: now.name.clone(), before_quantity: Some(was.quantity), after_quantity: Some(now.quantity), real_change: Some(real_change), kind: kind_of(real_change) }
            }
        });
    }
    rows.extend(before.iter().filter(|(code, _)| !after.contains_key(*code)).map(|(code, was)| EtfChangeRow { code: (*code).into(), name: was.name.clone(), before_quantity: Some(was.quantity), after_quantity: None, real_change: None, kind: EtfChangeKind::Removed }));
    let magnitude = |row: &EtfChangeRow| row.real_change.map_or(0.0, f64::abs);
    rows.sort_by(|a, b| kind_rank(a.kind).cmp(&kind_rank(b.kind)).then_with(|| magnitude(b).partial_cmp(&magnitude(a)).unwrap_or(Ordering::Equal)).then_with(|| a.code.cmp(&b.code)));
    Comparison { common_scale, rows }
}

fn count(rows: &[EtfChangeRow], kind: EtfChangeKind) -> u32 {
    rows.iter().filter(|row| row.kind == kind).count() as u32
}

pub(super) fn pairs(collection: &Collection) -> Vec<EtfChangePair> {
    let days: Vec<&KstDate> = collection.keys().collect();
    let mut pairs: Vec<EtfChangePair> = days
        .windows(2)
        .map(|window| {
            let comparison = compare(&collection[window[0]], &collection[window[1]]);
            EtfChangePair {
                before: api::KstDate(*window[0]),
                after: api::KstDate(*window[1]),
                common_scale: comparison.common_scale,
                added: count(&comparison.rows, EtfChangeKind::Added),
                removed: count(&comparison.rows, EtfChangeKind::Removed),
                increased: count(&comparison.rows, EtfChangeKind::Increased),
                decreased: count(&comparison.rows, EtfChangeKind::Decreased),
            }
        })
        .collect();
    pairs.reverse();
    pairs
}

pub(super) fn changes(code: StockCode, collection: &Collection, before: KstDate, after: KstDate) -> Option<EtfChanges> {
    let comparison = compare(collection.get(&before)?, collection.get(&after)?);
    Some(EtfChanges { code: code.as_str().into(), before: api::KstDate(before), after: api::KstDate(after), common_scale: comparison.common_scale, rows: comparison.rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held(code: &str, quantity: f64) -> Held {
        Held { code: code.into(), name: code.into(), quantity }
    }

    #[test]
    fn median_of_even_count_is_the_mean_of_the_middle_two() {
        assert_eq!(median(vec![3.0, 1.0, 2.0, 10.0]), Some(2.5));
        assert_eq!(median(vec![]), None);
    }

    #[test]
    fn non_positive_quantities_count_as_not_held() {
        let comparison = compare(&[held("000001", 0.0), held("000002", 10.0)], &[held("000001", 5.0), held("000002", 10.0)]);
        let kinds: Vec<_> = comparison.rows.iter().map(|row| (row.code.as_str(), row.kind)).collect();
        assert_eq!(kinds, [("000001", EtfChangeKind::Added), ("000002", EtfChangeKind::Unchanged)]);
    }

    #[test]
    fn with_no_common_stock_there_is_no_scale() {
        let comparison = compare(&[held("000001", 1.0)], &[held("000002", 1.0)]);
        assert_eq!(comparison.common_scale, None);
        let kinds: Vec<_> = comparison.rows.iter().map(|row| row.kind).collect();
        assert_eq!(kinds, [EtfChangeKind::Added, EtfChangeKind::Removed]);
    }
}
