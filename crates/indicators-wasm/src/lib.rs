use domain::{KstTime, Period};
use indicators::{BarError, BarInput, Columns, Engine, LineId, Spec, SpecError, Tail};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const SPEC_VALIDATION: &str = r#"
export type SpecValidation = { ok: true } | { ok: false; errors: { field: string; message: string }[] };
"#;

fn json_value(json: &str) -> JsValue {
    js_sys::JSON::parse(json).expect_throw("serde_json이 만든 JSON")
}

fn messages(errors: &[SpecError]) -> String {
    errors.iter().map(|e| if e.field.is_empty() { e.message.clone() } else { format!("{}: {}", e.field, e.message) }).collect::<Vec<_>>().join(" ")
}

fn unix_seconds(t: f64) -> Result<i64, JsError> {
    if t.is_finite() && t.fract() == 0.0 {
        Ok(t as i64)
    } else {
        Err(JsError::new(&format!("봉 시각은 Unix 초 정수여야 합니다: {t}")))
    }
}

#[wasm_bindgen(js_name = validateSpec, unchecked_return_type = "SpecValidation")]
pub fn validate_spec(spec_json: &str) -> JsValue {
    let body = match Spec::parse_valid(spec_json) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(errors) => serde_json::json!({ "ok": false, "errors": errors }),
    };
    json_value(&body.to_string())
}

#[wasm_bindgen]
pub struct WasmEngine {
    engine: Engine,
    lines: Vec<LineId>,
}

fn bar(t: f64, open: f64, high: f64, low: f64, close: f64, volume: f64) -> Result<BarInput, JsError> {
    Ok(BarInput { t: unix_seconds(t)?, open, high, low, close, volume })
}

fn tail_values(tail: Result<Tail, BarError>) -> Result<Vec<f64>, JsError> {
    let tail = tail.map_err(|e| JsError::new(&e.to_string()))?;
    Ok(tail.values.into_iter().map(|(_, v)| v).collect())
}

#[wasm_bindgen]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(
        spec_json: &str,
        t: &[f64],
        open: &[f64],
        high: &[f64],
        low: &[f64],
        close: &[f64],
        volume: &[f64],
    ) -> Result<WasmEngine, JsError> {
        let spec = Spec::parse_valid(spec_json).map_err(|errors| JsError::new(&messages(&errors)))?;
        let t = t.iter().map(|&t| unix_seconds(t)).collect::<Result<Vec<_>, _>>()?;
        let columns = Columns::new(&t, open, high, low, close, volume).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmEngine { engine: Engine::new(&spec, &columns), lines: spec.lines() })
    }

    #[wasm_bindgen(js_name = pushConfirmed)]
    pub fn push_confirmed(&mut self, t: f64, open: f64, high: f64, low: f64, close: f64, volume: f64) -> Result<Vec<f64>, JsError> {
        tail_values(self.engine.push_confirmed(&bar(t, open, high, low, close, volume)?))
    }

    pub fn preview(&self, t: f64, open: f64, high: f64, low: f64, close: f64, volume: f64) -> Result<Vec<f64>, JsError> {
        tail_values(self.engine.preview(&bar(t, open, high, low, close, volume)?))
    }

    pub fn line(&self, index: usize) -> Result<Vec<f64>, JsError> {
        self.line_at(index).map(|l| l.values.clone())
    }

    pub fn shift(&self, index: usize) -> Result<i32, JsError> {
        self.line_at(index).map(|l| l.shift)
    }

    pub fn lines(&self) -> Vec<String> {
        self.lines.iter().map(|id| id.as_wire().to_owned()).collect()
    }
}

impl WasmEngine {
    fn line_at(&self, index: usize) -> Result<&indicators::Line, JsError> {
        self.engine.output().lines.get(index).ok_or_else(|| JsError::new(&format!("선 번호가 범위 밖입니다: {index}")))
    }
}

#[wasm_bindgen(js_name = futureBarStarts)]
pub fn future_bar_starts(period: &str, last_start: f64, n: usize) -> Result<Vec<f64>, JsError> {
    let period = Period::parse(period).map_err(|e| JsError::new(&e.to_string()))?;
    let start = KstTime::from_unix(unix_seconds(last_start)?);
    let bucket = period.bucket(start);
    if bucket.start() != start {
        return Err(JsError::new(&format!("봉 시작 시각이 아닙니다: {start}")));
    }
    Ok(bucket.future_starts(n).into_iter().map(|t| t.unix() as f64).collect())
}
