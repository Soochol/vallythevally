use std::collections::HashMap;
use std::path::Path;

use indicators::{Columns, MaMethod, Spec, ValidSpec, compute};

const TOLERANCE: f64 = 1e-6;

struct Table {
    columns: HashMap<String, Vec<f64>>,
}

fn read(name: &str) -> Table {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/reference").join(format!("{name}.csv"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut rows = text.lines().filter(|l| !l.starts_with('#'));
    let header: Vec<String> = rows.next().unwrap().split(',').map(str::to_owned).collect();
    let mut columns: HashMap<String, Vec<f64>> = header.iter().map(|h| (h.clone(), Vec::new())).collect();
    for row in rows {
        for (h, cell) in header.iter().zip(row.split(',')) {
            let v = if cell.is_empty() { f64::NAN } else { cell.parse().unwrap() };
            columns.get_mut(h).unwrap().push(v);
        }
    }
    Table { columns }
}

/// 참조 라이브러리가 모든 출력 선을 가장 늦은 선에 맞춰 시작해서, 앞쪽 몇 봉은 우리 값만 있다(talib.STOCH).
enum Start {
    Same,
    ReferenceLater,
}

fn check(spec: Spec, file: &str, start: Start) {
    let input = read("input");
    let col = |name: &str| input.columns[name].clone();
    let (open, high, low, close, volume) = (col("open"), col("high"), col("low"), col("close"), col("volume"));
    let t: Vec<i64> = (0..close.len() as i64).map(|i| 1_700_000_000 + i * 86_400).collect();
    let bars = Columns::new(&t, &open, &high, &low, &close, &volume).unwrap();
    let expected = read(file);
    let output = compute(&ValidSpec::new(spec).unwrap(), &bars);
    assert_eq!(output.lines.len(), expected.columns.len(), "{file}: 선 개수");
    for line in &output.lines {
        let want = &expected.columns[line.id.as_wire()];
        assert_eq!(line.values.len(), want.len(), "{file} {:?}: 길이", line.id);
        let mut compared = 0;
        for (i, (&got, &want)) in line.values.iter().zip(want).enumerate() {
            if want.is_nan() {
                if matches!(start, Start::Same) {
                    assert!(got.is_nan(), "{file} {:?}[{i}]: 참조값은 비어 있는데 {got}", line.id);
                }
                continue;
            }
            assert!((got - want).abs() <= TOLERANCE, "{file} {:?}[{i}]: {got} ≠ {want}", line.id);
            compared += 1;
        }
        assert!(compared > 300, "{file} {:?}: 대조한 값이 {compared}개뿐", line.id);
    }
}

#[test]
fn sma() {
    check(Spec::Ma { method: MaMethod::Sma, period: 5 }, "ma_sma_5", Start::Same);
    check(Spec::Ma { method: MaMethod::Sma, period: 20 }, "ma_sma_20", Start::Same);
}

#[test]
fn ema() {
    check(Spec::Ma { method: MaMethod::Ema, period: 12 }, "ma_ema_12", Start::Same);
}

#[test]
fn bollinger() {
    check(Spec::Bollinger { period: 20, k: 2.0 }, "bollinger_20_2", Start::Same);
}

#[test]
fn ichimoku() {
    check(Spec::Ichimoku { conversion: 9, base: 26, span_b: 52, displacement: 26 }, "ichimoku_9_26_52_26", Start::Same);
}

#[test]
fn volume() {
    check(Spec::Volume { ma_period: Some(20) }, "volume_20", Start::Same);
}

#[test]
fn rsi() {
    check(Spec::Rsi { period: 14, signal: Some(9) }, "rsi_14_9", Start::Same);
}

#[test]
fn macd() {
    check(Spec::Macd { fast: 12, slow: 26, signal: 9 }, "macd_12_26_9", Start::Same);
}

#[test]
fn stoch_slow() {
    check(Spec::StochSlow { k: 5, d: 3, smooth: 3 }, "stoch_slow_5_3_3", Start::ReferenceLater);
    check(Spec::StochSlow { k: 14, d: 5, smooth: 3 }, "stoch_slow_14_5_3", Start::ReferenceLater);
}
