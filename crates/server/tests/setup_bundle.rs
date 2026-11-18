mod common;

use std::path::PathBuf;

use common::{ScriptedTransport, Server};
use serde_json::{Value, json};
use setup::{Bundle, DocumentKind, FORMAT_VERSION, JSON_LIMIT, LAYOUT_LIMIT};

const LAYOUT_ONE: &str = "0193aaaa-0000-7000-8000-000000000001";
const LAYOUT_TWO: &str = "0193aaaa-0000-7000-8000-000000000002";
const SYMBOLS: [&str; 3] = ["005930", "000660", "IDX:001"];
const APP_KEY: &str = "FAKE-APPKEY-bundle-4N7Q";
const APP_SECRET: &str = "FAKE-SECRET-bundle-8V2L";
const DART_KEY: &str = "FAKE-OPENDART-bundle-key";
const REGISTERED_IP: &str = "203.0.113.77";

struct Machine {
    _tmp: tempfile::TempDir,
    server: Server,
    base: String,
    port: u16,
    key_path: PathBuf,
    http: reqwest::Client,
}

async fn machine() -> Machine {
    let tmp = tempfile::tempdir().unwrap();
    let dist = tmp.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let lock = tmp.path().join("state/vallythevally/server.lock");
    let key_path = tmp.path().join("keys/vallythevally/kiwoom-key.json");
    let dart = [("OPENDART_API_KEY", DART_KEY), ("VALLY_DART_BASE_URL", "http://127.0.0.1:9"), ("VALLY_KIND_BASE_URL", "http://127.0.0.1:9")];
    let mut pairs = vec![("VALLY_KIWOOM_CONNECT", "off"), ("VALLY_KIWOOM_APP_KEY", ""), ("VALLY_KIWOOM_KEY_PATH", key_path.to_str().unwrap())];
    pairs.extend(dart);
    let overrides: Vec<(&str, &std::ffi::OsStr)> = pairs.iter().map(|(key, value)| (*key, std::ffi::OsStr::new(*value))).collect();
    let server = Server::spawn_with(&ScriptedTransport::new(), &lock, &dist, &overrides);
    let addr = server.addr().await;
    Machine { _tmp: tmp, server, base: format!("http://{addr}"), port: addr.port(), key_path, http: reqwest::Client::new() }
}

impl Machine {
    fn write(&self, method: reqwest::Method, path: &str, body: &Value) -> reqwest::RequestBuilder {
        self.http.request(method, format!("{}{path}", self.base)).header("content-type", "application/json").body(body.to_string())
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        answer(self.http.get(format!("{}{path}", self.base)).send().await.unwrap()).await
    }

    async fn put(&self, path: &str, body: &Value) -> (u16, Value) {
        answer(self.write(reqwest::Method::PUT, path, body).send().await.unwrap()).await
    }

    async fn saved(&self, path: &str, body: &Value) {
        let (status, answer) = self.put(path, body).await;
        assert_eq!(status, 200, "{path}: {answer}");
    }

    async fn export(&self) -> Value {
        let (status, bundle) = self.get("/api/setup/export").await;
        assert_eq!(status, 200, "{bundle}");
        bundle
    }

    async fn import(&self, bundle: &Value) -> (u16, Value) {
        self.put("/api/setup/import", bundle).await
    }

    async fn snapshot(&self) -> Value {
        let (_, list) = self.get("/api/layouts").await;
        let mut layouts = Vec::new();
        for summary in list.as_array().unwrap() {
            layouts.push(self.get(&format!("/api/layouts/{}", summary["id"].as_str().unwrap())).await.1);
        }
        let mut drawings = Vec::new();
        for symbol in SYMBOLS {
            drawings.push(self.get(&format!("/api/drawings?symbol={symbol}")).await.1);
        }
        json!({
            "watchlists": self.get("/api/watchlists").await.1,
            "screens": self.get("/api/screens").await.1,
            "uiState": self.get("/api/ui-state").await.1,
            "layoutList": list,
            "layouts": layouts,
            "drawings": drawings,
        })
    }
}

async fn answer(response: reqwest::Response) -> (u16, Value) {
    let status = response.status().as_u16();
    (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
}

fn layout(id: &str, name: &str, revision: i64, windows: Value) -> Value {
    json!({"id": id, "name": name, "revision": revision, "sync": {"crosshair": true, "scroll": false}, "placement": {"v": 1, "dock": null, "canvas": {"w": 3}}, "windows": windows})
}

fn drawing(id: &str, symbol: &str, scope: Value, revision: i64) -> Value {
    json!({"id": id, "symbol": symbol, "tool": "channel", "text": null, "style": {"v": 1, "color": "#fa0"}, "locked": false, "hidden": true, "periods": ["D", "W"], "z": 1.5, "group": "묶음", "scope": scope, "revision": revision,
           "points": [{"t": 1_794_100_000, "price": 100.0}, {"t": 1_794_200_000, "price": 110.5}, {"t": 1_794_100_000, "price": 105.0}]})
}

async fn fill(machine: &Machine) {
    let watchlists = json!({"lists": [
        {"id": "W1", "name": "기본", "symbols": ["005930", "000660", "IDX:001"], "groups": [
            {"id": "G1", "name": "반도체", "symbols": ["005930", "000660"]},
            {"id": "G2", "name": "겹침", "symbols": ["005930", "IDX:001"]},
        ]},
        {"id": "W2", "name": "둘", "symbols": ["005930"], "groups": []},
    ], "revision": 1_794_152_040_001_i64});
    let screens = json!({"screens": [{"id": "S1", "name": "신고가", "markets": ["kospi"], "exclude": ["etf"], "conditions": [{"kind": "new_high", "period": "D", "field": "high", "n": 200, "recentBars": 1}]}], "revision": 1_794_152_040_002_i64});
    let charts = json!([
        {"id": "cell-0", "link": "a", "kind": "chart", "symbol": "005930", "venue": "krx", "period": "15m", "chartSettings": {"v": 1, "indicators": ["ma"], "future": {"x": 1}}},
        {"id": "cell-1", "link": null, "kind": "chart", "symbol": "IDX:001", "venue": null, "period": "W", "chartSettings": {"v": 1}},
        {"id": "watchlist", "link": "a", "kind": "watchlist"},
    ]);
    machine.saved("/api/watchlists", &watchlists).await;
    machine.saved("/api/screens", &screens).await;
    machine.saved(&format!("/api/layouts/{LAYOUT_ONE}"), &layout(LAYOUT_ONE, "하나", 1_794_152_040_003_i64, json!([charts[0], charts[2]]))).await;
    machine.saved(&format!("/api/layouts/{LAYOUT_TWO}"), &layout(LAYOUT_TWO, "둘", 1_794_152_040_004_i64, charts)).await;
    machine.saved("/api/ui-state", &json!({"lastLayoutId": LAYOUT_TWO, "theme": "light", "watchCollapsed": true, "revision": 1_794_152_040_005_i64})).await;
    machine.saved("/api/drawings/D1", &drawing("D1", "005930", json!({"kind": "symbol"}), 1_794_152_040_006_i64)).await;
    machine.saved("/api/drawings/D2", &drawing("D2", "000660", json!({"kind": "layout", "layoutId": LAYOUT_ONE}), 1_794_152_040_007_i64)).await;
    machine.saved("/api/drawings/D3", &drawing("D3", "005930", json!({"kind": "cell", "layoutId": LAYOUT_TWO, "windowId": "cell-1"}), 1_794_152_040_008_i64)).await;
}

fn documents_of(bundle: &Value, kind: &str) -> Vec<Value> {
    bundle["documents"].as_array().unwrap().iter().filter(|d| d["kind"] == kind).cloned().collect()
}

fn with_document(bundle: &Value, kind: &str, id: &str, change: impl FnOnce(&mut Value)) -> Value {
    let mut edited = bundle.clone();
    let document = edited["documents"].as_array_mut().unwrap().iter_mut().find(|d| d["kind"] == kind && d["id"] == id).unwrap();
    change(document);
    edited
}

#[tokio::test]
async fn an_exported_setup_imports_into_an_empty_database_with_every_response_equal() {
    let (from, into) = (machine().await, machine().await);
    fill(&from).await;
    let want = from.snapshot().await;
    let bundle = from.export().await;

    assert_eq!(bundle["version"], FORMAT_VERSION);
    let parsed: Bundle = serde_json::from_value(bundle.clone()).unwrap();
    parsed.check().unwrap();
    let counts: Vec<_> = DocumentKind::ALL.iter().map(|kind| documents_of(&bundle, kind.wire_name()).len()).collect();
    assert_eq!(counts, [1, 1, 1, 3, 3], "관심종목·조건식·화면 상태 하나씩, 기본 레이아웃과 둘, 드로잉 셋(모든 종목)");
    let ui_state = &documents_of(&bundle, "ui_state")[0];
    assert!(ui_state["body"].get("revision").is_none() && ui_state["revision"] == 1_794_152_040_005_i64, "{ui_state}");

    let (status, answer) = into.import(&bundle).await;
    assert_eq!((status, &answer["documents"]), (200, &json!(9)), "{answer}");
    let got = into.snapshot().await;
    assert_eq!(got, want);
    assert_eq!(got["layoutList"].as_array().unwrap().len(), 3);
    assert_eq!(into.export().await, bundle, "가져온 셋업을 다시 내보내면 같은 묶음이다");
    assert_eq!(into.import(&bundle).await.0, 200, "같은 묶음을 다시 가져와도 같다");
    assert_eq!(into.snapshot().await, want);
}

#[tokio::test]
async fn an_import_replaces_local_documents_the_bundle_does_not_have() {
    let (from, into) = (machine().await, machine().await);
    fill(&from).await;
    into.saved("/api/layouts/EXTRA", &layout("EXTRA", "남는 것", 5, json!([{"id": "cell-0", "link": null, "kind": "chart", "symbol": "IDX:001", "venue": null, "period": "D", "chartSettings": {"v": 1}}]))).await;
    into.saved("/api/drawings/GONE", &drawing("GONE", "005930", json!({"kind": "layout", "layoutId": "EXTRA"}), 5)).await;
    assert_eq!(into.import(&from.export().await).await.0, 200);
    assert_eq!(into.snapshot().await, from.snapshot().await);
    assert_eq!(into.get("/api/layouts/EXTRA").await.0, 404);
}

#[tokio::test]
async fn a_bundle_with_one_bad_document_is_refused_whole_and_names_the_document() {
    let (from, into) = (machine().await, machine().await);
    fill(&from).await;
    into.saved("/api/layouts/EXTRA", &layout("EXTRA", "남는 것", 5, json!([{"id": "cell-0", "link": null, "kind": "chart", "symbol": "IDX:001", "venue": null, "period": "D", "chartSettings": {"v": 1}}]))).await;
    let before = (into.snapshot().await, into.export().await);
    let bundle = from.export().await;

    let oversized_placement = json!({"v": 1, "pad": "x".repeat(JSON_LIMIT)});
    let oversized_layout = json!("x".repeat(LAYOUT_LIMIT));
    let cases = [
        ("없는 레이아웃을 가리키는 드로잉", with_document(&bundle, "drawing", "D2", |d| d["body"]["scope"] = json!({"kind": "layout", "layoutId": "nope"})), "drawing", "D2", 400),
        ("없는 창을 가리키는 드로잉", with_document(&bundle, "drawing", "D3", |d| d["body"]["scope"]["windowId"] = json!("cell-9")), "drawing", "D3", 400),
        ("본문이 한도를 넘는 레이아웃", with_document(&bundle, "layout", LAYOUT_TWO, |d| d["body"]["placement"] = oversized_placement.clone()), "layout", LAYOUT_TWO, 400),
        ("문서 한도를 넘는 레이아웃", with_document(&bundle, "layout", LAYOUT_TWO, |d| d["body"]["pad"] = oversized_layout.clone()), "layout", LAYOUT_TWO, 400),
        ("본문 id가 다른 레이아웃", with_document(&bundle, "layout", LAYOUT_TWO, |d| d["body"]["id"] = json!("other")), "layout", LAYOUT_TWO, 400),
        ("같은 이름의 레이아웃", with_document(&bundle, "layout", LAYOUT_TWO, |d| d["body"]["name"] = json!("하나")), "layout", LAYOUT_TWO, 400),
        ("종목 코드가 틀린 관심종목", with_document(&bundle, "watchlists", "main", |d| d["body"]["lists"][1]["symbols"] = json!(["abc"])), "watchlists", "main", 400),
        ("겹치는 조건식 id", with_document(&bundle, "screens", "main", |d| { let first = d["body"]["screens"][0].clone(); d["body"]["screens"].as_array_mut().unwrap().push(first); }), "screens", "main", 400),
        ("객체가 아닌 화면 상태", with_document(&bundle, "ui_state", "main", |d| d["body"] = json!([1])), "ui_state", "main", 400),
        ("고정 id가 아닌 관심종목", with_document(&bundle, "watchlists", "main", |d| d["id"] = json!("W1")), "watchlists", "W1", 400),
        ("삭제 문서", with_document(&bundle, "drawing", "D1", |d| { d["deleted"] = json!(true); d.as_object_mut().unwrap().remove("body"); }), "drawing", "D1", 400),
        ("다른 형식 버전", { let mut v = bundle.clone(); v["version"] = json!(2); v }, "", "", 400),
        ("모르는 문서 종류", with_document(&bundle, "drawing", "D1", |d| d["kind"] = json!("quotes")), "", "", 400),
    ];
    for (label, tampered, kind, id, status) in cases {
        let (got, answer) = into.import(&tampered).await;
        assert_eq!(got, status, "{label}: {answer}");
        let message = answer["error"]["message"].as_str().unwrap();
        assert!(message.contains(kind) && message.contains(id), "{label}: 어느 문서인지 알려야 한다: {message}");
        assert_eq!((into.snapshot().await, into.export().await), before, "{label}: 거절한 묶음은 로컬 자료를 바꾸지 않는다");
    }

    let without_layouts = {
        let mut v = bundle.clone();
        v["documents"].as_array_mut().unwrap().retain(|d| d["kind"] != "layout");
        v
    };
    assert_eq!(into.import(&without_layouts).await.0, 400, "레이아웃이 하나도 없는 묶음은 받지 않는다");
    let without_watchlists = {
        let mut v = bundle.clone();
        v["documents"].as_array_mut().unwrap().retain(|d| d["kind"] != "watchlists");
        v
    };
    assert_eq!(into.import(&without_watchlists).await.0, 400);
    assert_eq!(into.snapshot().await, before.0);

    let mut late = before.1.clone();
    late["documents"].as_array_mut().unwrap().iter_mut().for_each(|d| d["revision"] = json!(0));
    assert_eq!(into.import(&late).await.0, 200, "받은 revision을 그대로 저장하므로 로컬보다 낮아도 받는다");
    assert_eq!(into.export().await, late);
}

#[tokio::test]
async fn an_old_layout_with_an_objects_window_is_imported_without_that_window_and_other_unknown_kinds_are_still_refused() {
    let (from, into) = (machine().await, machine().await);
    fill(&from).await;
    let bundle = from.export().await;
    let objects = json!({"id": "objects", "link": null, "kind": "objects"});
    let old = with_document(&bundle, "layout", LAYOUT_TWO, |d| d["body"]["windows"].as_array_mut().unwrap().push(objects.clone()));

    let (status, answer) = into.import(&old).await;
    assert_eq!(status, 200, "{answer}");
    let (_, saved) = into.get(&format!("/api/layouts/{LAYOUT_TWO}")).await;
    let kinds: Vec<_> = saved["windows"].as_array().unwrap().iter().map(|w| w["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["chart", "chart", "watchlist"], "개체 목록 창만 빠진 채 저장된다");
    assert_eq!(into.snapshot().await, from.snapshot().await);

    let unknown = with_document(&bundle, "layout", LAYOUT_TWO, |d| d["body"]["windows"].as_array_mut().unwrap().push(json!({"id": "x", "link": null, "kind": "nope"})));
    let (status, answer) = into.import(&unknown).await;
    assert_eq!(status, 400, "{answer}");
    assert!(answer["error"]["message"].as_str().unwrap().contains(LAYOUT_TWO));
}

#[tokio::test]
async fn a_layout_with_two_windows_of_one_kind_is_imported() {
    let (from, into) = (machine().await, machine().await);
    fill(&from).await;
    let twins = [json!({"id": "trades", "link": "a", "kind": "trades"}), json!({"id": "trades-2", "link": "b", "kind": "trades"}), json!({"id": "order", "link": null, "kind": "order", "venue": "krx"}), json!({"id": "order-2", "link": "b", "kind": "order", "venue": "nxt"})];
    let bundle = with_document(&from.export().await, "layout", LAYOUT_TWO, |d| d["body"]["windows"].as_array_mut().unwrap().extend(twins.clone()));

    let (status, answer) = into.import(&bundle).await;
    assert_eq!(status, 200, "{answer}");
    let (_, saved) = into.get(&format!("/api/layouts/{LAYOUT_TWO}")).await;
    let ids: Vec<_> = saved["windows"].as_array().unwrap().iter().map(|w| w["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["cell-0", "cell-1", "watchlist", "trades", "trades-2", "order", "order-2"]);
    assert_eq!(saved["windows"][6]["venue"], "nxt");
}

#[tokio::test]
async fn a_hidden_drawing_in_a_bundle_is_stored_visible() {
    let (from, into) = (machine().await, machine().await);
    fill(&from).await;
    let bundle = with_document(&from.export().await, "drawing", "D1", |d| d["body"]["hidden"] = json!(true));
    assert_eq!(into.import(&bundle).await.0, 200);
    let (_, stored) = into.get("/api/drawings?symbol=005930").await;
    assert!(stored.as_array().unwrap().iter().all(|d| d["hidden"] == json!(false)), "{stored}");
}

#[tokio::test]
async fn the_bundle_never_carries_kiwoom_keys_tokens_the_registered_ip_or_the_opendart_key() {
    let machine = machine().await;
    fill(&machine).await;
    assert_eq!(machine.put("/api/system/kiwoom/key", &json!({"appKey": APP_KEY, "appSecret": APP_SECRET})).await.0, 200);
    assert_eq!(machine.put("/api/system/kiwoom/registered-ip", &json!({"ip": REGISTERED_IP})).await.0, 200);
    let key_file = std::fs::read_to_string(&machine.key_path).unwrap();
    assert!(key_file.contains(APP_KEY), "키 파일에 가짜 키가 들어 있다");
    let token = common::support::token_for(APP_KEY);

    let bundle = machine.export().await;
    let text = bundle.to_string();
    for secret in [APP_KEY, APP_SECRET, DART_KEY, REGISTERED_IP, token.as_str(), "appKey", "appSecret", "registeredIp"] {
        assert!(!text.contains(secret), "묶음에 {secret}이 있다");
    }
    let kinds: std::collections::BTreeSet<&str> = bundle["documents"].as_array().unwrap().iter().map(|d| d["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["drawing", "layout", "screens", "ui_state", "watchlists"].into());
    let logs = machine.server.stop().await;
    assert!(!logs.contains(APP_SECRET) && !logs.contains(DART_KEY), "로그에 비밀값이 있다");
}

#[tokio::test]
async fn an_import_from_another_host_origin_or_content_type_is_refused_and_leaves_the_setup_alone() {
    let (from, into) = (machine().await, machine().await);
    fill(&from).await;
    let bundle = from.export().await;
    let before = (into.snapshot().await, into.export().await);
    let url = format!("{}/api/setup/import", into.base);
    let put = || into.write(reqwest::Method::PUT, "/api/setup/import", &bundle);
    let requests = [
        ("host", put().header("host", format!("evil.example:{}", into.port))),
        ("origin", put().header("origin", "https://evil.example")),
        ("scheme", put().header("origin", format!("https://127.0.0.1:{}", into.port))),
        ("port", put().header("host", format!("127.0.0.1:{}", into.port.wrapping_add(1)))),
        ("text/plain", into.http.put(&url).header("content-type", "text/plain").body(bundle.to_string())),
        ("type 없음", into.http.put(&url).body(bundle.to_string())),
    ];
    for (label, request) in requests {
        let (status, answer) = answer(request.send().await.unwrap()).await;
        assert_eq!(status, 400, "{label}: {answer}");
    }
    assert_eq!((into.snapshot().await, into.export().await), before);
    assert_eq!(into.import(&bundle).await.0, 200, "같은 요청이 Host·Origin·Content-Type이 맞으면 받는다");
    assert_eq!(into.get("/api/setup/export").await.0, 200, "읽기에는 이 검사를 걸지 않는다");
}

#[tokio::test]
async fn an_id_the_format_refuses_is_refused_at_save_so_every_saved_setup_exports() {
    let machine = machine().await;
    fill(&machine).await;
    let charts = json!([{"id": "cell-0", "link": null, "kind": "chart", "symbol": "IDX:001", "venue": null, "period": "D", "chartSettings": {"v": 1}}]);
    for id in ["a.b", "a b", "내 레이아웃", &"a".repeat(65)] {
        let path = format!("/api/layouts/{}", id.replace(' ', "%20"));
        assert_eq!(machine.put(&path, &layout(id, "새것", 9_000_000_000_000, charts.clone())).await.0, 400, "{id}");
        let path = format!("/api/drawings/{}", id.replace(' ', "%20"));
        assert_eq!(machine.put(&path, &drawing(id, "005930", json!({"kind": "symbol"}), 9_000_000_000_000)).await.0, 400, "{id}");
    }
    assert_eq!(machine.get("/api/setup/export").await.0, 200);
}

#[tokio::test]
async fn a_drawing_saved_at_the_route_body_limit_still_exports_and_imports() {
    let (from, into) = (machine().await, machine().await);
    fill(&from).await;
    let mut full = drawing("BIG", "005930", json!({"kind": "symbol"}), 9_000_000_000_000);
    full["style"] = json!({"pad": ""});
    let room = JSON_LIMIT - full.to_string().len();
    full["style"] = json!({"pad": "x".repeat(room)});
    assert_eq!(full.to_string().len(), JSON_LIMIT);
    from.saved("/api/drawings/BIG", &full).await;
    let bundle = from.export().await;
    assert_eq!(into.import(&bundle).await.0, 200);
    assert_eq!(into.snapshot().await, from.snapshot().await);
}

#[tokio::test]
async fn an_export_made_while_layouts_and_drawings_change_is_one_consistent_snapshot() {
    let machine = machine().await;
    fill(&machine).await;
    let charts = json!([{"id": "cell-0", "link": null, "kind": "chart", "symbol": "IDX:001", "venue": null, "period": "D", "chartSettings": {"v": 1}}]);
    let churn = async {
        for n in 0..25_i64 {
            let (layout_id, drawing_id) = (format!("R{n}"), format!("RD{n}"));
            machine.saved(&format!("/api/layouts/{layout_id}"), &layout(&layout_id, &format!("임시 {n}"), 9_000_000_000_000 + n, charts.clone())).await;
            machine.saved(&format!("/api/drawings/{drawing_id}"), &drawing(&drawing_id, "005930", json!({"kind": "layout", "layoutId": layout_id}), 9_000_000_000_000 + n)).await;
            if n > 0 {
                let previous = n - 1;
                assert_eq!(machine.write(reqwest::Method::DELETE, &format!("/api/drawings/RD{previous}"), &json!({})).send().await.unwrap().status(), 204);
                assert_eq!(machine.write(reqwest::Method::DELETE, &format!("/api/layouts/R{previous}"), &json!({})).send().await.unwrap().status(), 204);
            }
        }
    };
    let exports = async {
        let mut bundles = Vec::new();
        for _ in 0..40 {
            let (status, bundle) = machine.get("/api/setup/export").await;
            assert_eq!(status, 200, "{bundle}");
            bundles.push(bundle);
        }
        bundles
    };
    let ((), bundles) = tokio::join!(churn, exports);
    for bundle in bundles {
        let layouts: std::collections::BTreeSet<String> = documents_of(&bundle, "layout").iter().map(|d| d["id"].as_str().unwrap().to_owned()).collect();
        for drawing in documents_of(&bundle, "drawing") {
            if let Some(layout_id) = drawing["body"]["scope"]["layoutId"].as_str() {
                assert!(layouts.contains(layout_id), "묶음 안의 드로잉이 묶음에 없는 레이아웃을 가리킨다: {layout_id}");
            }
        }
    }
}
