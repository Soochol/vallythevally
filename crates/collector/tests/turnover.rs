use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::kst::KstTime;
use collector::turnover::{collect_turnover, latest_turnover, turnover_path};
use domain::KstDate;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use server::clock::{Clock, kst};
use server::config::Secret;
use server::kiwoom::auth::KiwoomAuth;
use server::kiwoom::rest::KiwoomRest;
use server::kiwoom::transport::{HttpRequest, HttpResponse, Transport, TransportError};

const DATE: u32 = 20261118;
const PREVIOUS_DATE: u32 = 20261117;

fn now_kst() -> KstTime {
    KstTime { date: DATE, ms_of_day: (20 * 3600 + 6 * 60) * 1000 }
}

fn fake_clock() -> Clock {
    Clock::fake(kst(KstDate::parse_yyyymmdd("20261118").unwrap(), 20, 6, 0))
}

fn codes_of(count: usize) -> Vec<String> {
    (1..=count).map(|number| format!("{number:06}")).collect()
}

fn quote_row(stk_cd: &str, dt: &str, trde_prica: &str) -> Value {
    json!({
        "stk_cd": stk_cd,
        "cur_prc": "+1000",
        "base_pric": "1000",
        "pred_pre_sig": "3",
        "trde_qty": "10",
        "dt": dt,
        "cntr_tm": "195959",
        "open_pric": "1000",
        "high_pric": "1000",
        "low_pric": "1000",
        "trde_prica": trde_prica,
    })
}

fn ok_response(body: Value) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse { status: 200, next_key: None, body: body.to_string() })
}

type QuoteResponder = Box<dyn Fn(usize, &[String]) -> Result<Vec<Value>, TransportError> + Send + Sync>;

struct FakeKiwoom {
    quote_calls: AtomicUsize,
    responder: Mutex<QuoteResponder>,
}

impl FakeKiwoom {
    fn new(responder: impl Fn(usize, &[String]) -> Result<Vec<Value>, TransportError> + Send + Sync + 'static) -> Arc<FakeKiwoom> {
        Arc::new(FakeKiwoom { quote_calls: AtomicUsize::new(0), responder: Mutex::new(Box::new(responder)) })
    }

    fn calls(&self) -> usize {
        self.quote_calls.load(Ordering::SeqCst)
    }
}

impl Transport for FakeKiwoom {
    fn send(&self, request: HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> {
        let api = request.api_id.as_str().to_owned();
        if api == "au10001" {
            let answer = ok_response(json!({"token": "tok", "expires_dt": "20991231000000", "return_code": 0, "return_msg": "정상"}));
            return Box::pin(async move { answer });
        }
        assert_eq!(api, "ka10095");
        let body: Value = serde_json::from_str(request.body.expose()).unwrap();
        let asked: Vec<String> = body["stk_cd"].as_str().unwrap().split('|').map(str::to_owned).collect();
        let call_index = self.quote_calls.fetch_add(1, Ordering::SeqCst);
        let answer = match (self.responder.lock().unwrap())(call_index, &asked) {
            Ok(rows) => ok_response(json!({"atn_stk_infr": rows, "return_code": 0, "return_msg": "정상"})),
            Err(error) => Err(error),
        };
        Box::pin(async move { answer })
    }
}

fn rest_of(fake: &Arc<FakeKiwoom>) -> KiwoomRest {
    let auth = KiwoomAuth::new(Secret::new("key".into()), Secret::new("secret".into()), None);
    KiwoomRest::with_send_spacing(fake.clone(), auth, fake_clock(), Duration::ZERO)
}

fn write_turnover_json(data_dir: &Path, date: u32, traded: Value) {
    let path = turnover_path(data_dir, date);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let body = json!({
        "format_version": 1,
        "date": date,
        "fetched_at": "2026-11-17T20:06:00+09:00",
        "traded_million_won": traded,
    });
    fs::write(path, body.to_string()).unwrap();
}

#[tokio::test]
async fn a_failed_later_batch_writes_no_file() {
    let codes = codes_of(250);
    let failing_dir = tempfile::tempdir().unwrap();
    let failing = FakeKiwoom::new(|call_index, asked| {
        if call_index >= 1 {
            return Err(TransportError::refused());
        }
        Ok(asked
            .iter()
            .map(|stk_cd| {
                let number: u64 = stk_cd.trim_end_matches("_AL").parse().unwrap();
                quote_row(stk_cd, "20261118", &number.to_string())
            })
            .collect())
    });
    let result = collect_turnover(&rest_of(&failing), failing_dir.path(), DATE, now_kst(), &codes).await;
    assert!(result.is_err());
    assert!(!turnover_path(failing_dir.path(), DATE).exists());

    let ok_dir = tempfile::tempdir().unwrap();
    let succeeding = FakeKiwoom::new(|_, asked| {
        Ok(asked
            .iter()
            .map(|stk_cd| {
                let number: u64 = stk_cd.trim_end_matches("_AL").parse().unwrap();
                quote_row(stk_cd, "20261118", &(number * 10).to_string())
            })
            .collect())
    });
    let saved = collect_turnover(&rest_of(&succeeding), ok_dir.path(), DATE, now_kst(), &codes).await.unwrap();
    assert_eq!(succeeding.calls(), 3);
    assert_eq!(saved.traded_million_won.len(), 250);
    assert_eq!(saved.traded_million_won.get("000250"), Some(&2500));
    assert!(turnover_path(ok_dir.path(), DATE).is_file());
}

#[tokio::test]
async fn odd_rows_are_left_out_and_a_mostly_missing_reply_fails() {
    let codes = codes_of(10);
    let partial_dir = tempfile::tempdir().unwrap();
    let partial = FakeKiwoom::new(|_, asked| {
        let mut rows = Vec::new();
        for stk_cd in asked {
            let code = stk_cd.trim_end_matches("_AL");
            match code {
                "000001" => {}
                "000002" => rows.push(quote_row(stk_cd, &PREVIOUS_DATE.to_string(), "200")),
                "000003" => {
                    rows.push(quote_row(stk_cd, "20261118", "300"));
                    rows.push(quote_row(stk_cd, "20261118", "301"));
                }
                "000004" => rows.push(quote_row(stk_cd, "20261118", "abc")),
                other => {
                    let number: u64 = other.parse().unwrap();
                    let signed = if number.is_multiple_of(2) { format!("-{}", number * 100) } else { format!("+{}", number * 100) };
                    rows.push(quote_row(stk_cd, "20261118", &signed));
                }
            }
        }
        Ok(rows)
    });
    let saved = collect_turnover(&rest_of(&partial), partial_dir.path(), DATE, now_kst(), &codes).await.unwrap();
    let expected: BTreeMap<String, u64> = (5..=10).map(|number| (format!("{number:06}"), number as u64 * 100)).collect();
    assert_eq!(saved.traded_million_won, expected);
    assert!(turnover_path(partial_dir.path(), DATE).is_file());

    let sparse_dir = tempfile::tempdir().unwrap();
    let sparse = FakeKiwoom::new(|_, asked| {
        let rows = asked
            .iter()
            .take(4)
            .map(|stk_cd| quote_row(stk_cd, "20261118", "500"))
            .collect();
        Ok(rows)
    });
    let result = collect_turnover(&rest_of(&sparse), sparse_dir.path(), DATE, now_kst(), &codes).await;
    assert!(result.is_err());
    assert!(!turnover_path(sparse_dir.path(), DATE).exists());
}

#[test]
fn a_file_is_usable_only_when_fresh_and_not_empty() {
    let dir = tempfile::tempdir().unwrap();
    write_turnover_json(dir.path(), 20261112, json!({"000001": 100}));
    write_turnover_json(dir.path(), 20261116, json!({"000001": 200}));
    write_turnover_json(dir.path(), 20261117, json!({}));

    let picked = latest_turnover(dir.path(), 20261113, DATE).unwrap();
    assert_eq!(picked.date, 20261116);
    assert_eq!(picked.traded_million_won.get("000001"), Some(&200));

    let only_stale_and_empty = tempfile::tempdir().unwrap();
    write_turnover_json(only_stale_and_empty.path(), 20261112, json!({"000001": 100}));
    write_turnover_json(only_stale_and_empty.path(), 20261117, json!({}));
    assert_eq!(latest_turnover(only_stale_and_empty.path(), 20261113, DATE), None);
}
