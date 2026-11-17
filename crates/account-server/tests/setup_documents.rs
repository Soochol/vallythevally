mod common;

use common::*;
use serde_json::{Value, json};
use setup::{ACCOUNT_LIMIT, DocumentKind};

struct Account<'a> {
    harness: &'a Harness,
    token: String,
}

impl<'a> Account<'a> {
    async fn login(harness: &'a Harness, subject: &str) -> Account<'a> {
        harness.idp.set_subject(subject);
        let (token, _) = harness.token_for("google", subject).await;
        Account { harness, token }
    }

    async fn push(&self, documents: Value) -> Value {
        let response = self.push_raw(documents).await;
        assert_eq!(response.status(), 200);
        response.json().await.unwrap()
    }

    async fn push_raw(&self, documents: Value) -> reqwest::Response {
        self.harness
            .http
            .post(format!("{}/v1/setup/push", self.harness.base))
            .bearer_auth(&self.token)
            .json(&json!({ "documents": documents }))
            .send()
            .await
            .unwrap()
    }

    async fn changes(&self, query: &str) -> Value {
        let response = self.harness.http.get(format!("{}/v1/setup/changes?{query}", self.harness.base)).bearer_auth(&self.token).send().await.unwrap();
        assert_eq!(response.status(), 200);
        response.json().await.unwrap()
    }

    async fn summary(&self) -> Value {
        let response = self.harness.http.get(format!("{}/v1/setup/summary", self.harness.base)).bearer_auth(&self.token).send().await.unwrap();
        assert_eq!(response.status(), 200);
        response.json().await.unwrap()
    }
}

fn live(kind: &str, id: &str, revision: i64, body: Value) -> Value {
    json!({"kind": kind, "id": id, "revision": revision, "deleted": false, "body": body})
}

fn gone(kind: &str, id: &str, revision: i64) -> Value {
    json!({"kind": kind, "id": id, "revision": revision, "deleted": true})
}

fn padded(bytes: usize) -> Value {
    json!({ "pad": "x".repeat(bytes - r#"{"pad":""}"#.len()) })
}

fn statuses(response: &Value) -> Vec<&str> {
    response["results"].as_array().unwrap().iter().map(|result| result["status"].as_str().unwrap()).collect()
}

fn keys(documents: &Value) -> Vec<(String, String, i64, bool)> {
    documents
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["kind"].as_str().unwrap().into(), d["id"].as_str().unwrap().into(), d["revision"].as_i64().unwrap(), d["deleted"].as_bool().unwrap()))
        .collect()
}

#[tokio::test]
async fn pushed_documents_come_back_from_changes_in_sequence_order() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let documents = json!([
        live("watchlists", "main", 1, json!({"lists": []})),
        live("screens", "main", 2, json!({"screens": []})),
        live("ui_state", "main", 3, json!({"theme": "dark"})),
        live("layout", "L1", 4, json!({"windows": []})),
        live("drawing", "D1", 5, json!({"lines": []})),
    ]);
    let pushed = account.push(documents.clone()).await;
    assert_eq!(statuses(&pushed), ["accepted"; 5]);
    let seqs: Vec<i64> = pushed["results"].as_array().unwrap().iter().map(|r| r["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, [1, 2, 3, 4, 5]);
    assert_eq!(pushed["seq"], 5);

    let changes = account.changes("since=0").await;
    assert_eq!(changes["documents"], documents);
    assert_eq!((changes["seq"].as_i64(), changes["more"].as_bool()), (Some(5), Some(false)));

    let again = account.changes(&format!("since={}", changes["seq"])).await;
    assert_eq!(again["documents"], json!([]));
    assert_eq!((again["seq"].as_i64(), again["more"].as_bool()), (Some(5), Some(false)));
    assert_eq!(account.summary().await, json!({"documents": 5, "bytes": changes["documents"].as_array().unwrap().iter().map(|d| d["body"].to_string().len()).sum::<usize>(), "seq": 5}));
}

#[tokio::test]
async fn changes_pages_by_count_and_continues_from_the_returned_seq() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let documents: Vec<Value> = (0..5).map(|n| live("drawing", &format!("D{n}"), 1, json!({"n": n}))).collect();
    account.push(json!(documents)).await;
    account.push(json!([live("drawing", "D0", 2, json!({"n": "again"}))])).await;
    let first = account.changes("since=0&limit=3").await;
    assert_eq!(first["more"], true);
    assert_eq!(first["documents"].as_array().unwrap().len(), 3);
    let second = account.changes(&format!("since={}&limit=3", first["seq"])).await;
    assert_eq!(second["more"], false);
    let mut seen: Vec<_> = keys(&first["documents"]).into_iter().chain(keys(&second["documents"])).collect();
    seen.sort();
    assert_eq!(
        seen,
        [("drawing", "D0", 2, false), ("drawing", "D1", 1, false), ("drawing", "D2", 1, false), ("drawing", "D3", 1, false), ("drawing", "D4", 1, false)]
            .map(|(k, i, r, d)| (k.to_owned(), i.to_owned(), r, d))
    );
    assert_eq!(second["seq"], 6);
    for bad in ["since=-1", "since=x", "limit=0", "limit=501"] {
        let response = harness.http.get(format!("{}/v1/setup/changes?{bad}", harness.base)).bearer_auth(&account.token).send().await.unwrap();
        assert_eq!(response.status(), 400, "{bad}");
    }
}

#[tokio::test]
async fn changes_stops_at_the_byte_budget_and_says_there_is_more() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let size = DocumentKind::Layout.document_limit();
    for chunk in 0..3 {
        let documents: Vec<Value> = (0..5).map(|n| live("layout", &format!("L{chunk}-{n}"), 1, padded(size))).collect();
        assert_eq!(statuses(&account.push(json!(documents)).await), ["accepted"; 5]);
    }
    let mut received = 0;
    let mut since = 0;
    let mut pages = 0;
    loop {
        let page = account.changes(&format!("since={since}")).await;
        let count = page["documents"].as_array().unwrap().len();
        assert!(count <= 8 * 1024 * 1024 / size + 1);
        received += count;
        pages += 1;
        since = page["seq"].as_i64().unwrap();
        if !page["more"].as_bool().unwrap() {
            break;
        }
    }
    assert_eq!(received, 15);
    assert!(pages >= 2, "한 응답에 다 담기지 않아야 한다");
}

#[tokio::test]
async fn a_revision_must_exceed_the_stored_one_and_the_loser_gets_the_stored_document() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let stored = live("layout", "L1", 10, json!({"v": "ten"}));
    assert_eq!(statuses(&account.push(json!([stored.clone()])).await), ["accepted"]);
    for revision in [9, 10] {
        let response = account.push(json!([live("layout", "L1", revision, json!({"v": "loser"}))])).await;
        assert_eq!(statuses(&response), ["stale"]);
        assert_eq!(response["results"][0]["document"], stored);
        assert_eq!(response["seq"], 1);
    }
    let accepted = account.push(json!([live("layout", "L1", 11, json!({"v": "eleven"}))])).await;
    assert_eq!(statuses(&accepted), ["accepted"]);
    assert_eq!(accepted["seq"], 2);
    let changes = account.changes("since=0").await;
    assert_eq!(changes["documents"], json!([live("layout", "L1", 11, json!({"v": "eleven"}))]));
}

#[tokio::test]
async fn a_deleted_document_is_a_tombstone_that_a_smaller_revision_cannot_revive() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    account.push(json!([live("drawing", "D1", 5, json!({})), live("drawing", "D2", 5, json!({}))])).await;
    assert_eq!(account.summary().await["documents"], 2);

    assert_eq!(statuses(&account.push(json!([gone("drawing", "D1", 10)])).await), ["accepted"]);
    let changes = account.changes("since=2").await;
    assert_eq!(changes["documents"], json!([gone("drawing", "D1", 10)]));
    assert_eq!(account.summary().await["documents"], 1);

    for revision in [9, 10] {
        let revive = account.push(json!([live("drawing", "D1", revision, json!({"back": true}))])).await;
        assert_eq!(statuses(&revive), ["stale"]);
        assert_eq!(revive["results"][0]["document"], gone("drawing", "D1", 10));
    }
    assert_eq!(account.summary().await["documents"], 1);
    assert_eq!(statuses(&account.push(json!([live("drawing", "D1", 11, json!({"back": true}))])).await), ["accepted"]);
    assert_eq!(account.summary().await["documents"], 2);
    assert_eq!(statuses(&account.push(json!([gone("drawing", "never-stored", 1)])).await), ["accepted"]);
}

#[tokio::test]
async fn an_account_never_sees_or_changes_another_accounts_documents() {
    let harness = Harness::start().await;
    let a = Account::login(&harness, "a").await;
    let b = Account::login(&harness, "b").await;
    a.push(json!([live("layout", "L1", 50, json!({"owner": "a"})), live("ui_state", "main", 50, json!({"owner": "a"}))])).await;

    assert_eq!(b.changes("since=0").await["documents"], json!([]));
    assert_eq!(b.summary().await, json!({"documents": 0, "bytes": 0, "seq": 0}));

    let pushed = b.push(json!([live("layout", "L1", 1, json!({"owner": "b"}))])).await;
    assert_eq!(statuses(&pushed), ["accepted"]);
    assert_eq!(pushed["seq"], 1);
    assert_eq!(statuses(&b.push(json!([gone("ui_state", "main", 99)])).await), ["accepted"]);

    let seen_by_a = a.changes("since=0").await;
    assert_eq!(seen_by_a["documents"], json!([live("layout", "L1", 50, json!({"owner": "a"})), live("ui_state", "main", 50, json!({"owner": "a"}))]));
    assert_eq!(b.changes("since=0").await["documents"], json!([live("layout", "L1", 1, json!({"owner": "b"})), gone("ui_state", "main", 99)]));
    assert_eq!(a.summary().await["documents"], 2);
}

#[tokio::test]
async fn a_malformed_document_is_rejected_alone_and_the_rest_of_the_request_is_stored() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let too_big = padded(DocumentKind::Drawing.document_limit() + 1);
    let documents = json!([
        live("drawing", "ok-1", 1, json!({})),
        live("quotes", "main", 1, json!({})),
        live("layout", "bad id", 1, json!({})),
        live("drawing", "big", 1, too_big),
        {"kind": "layout", "id": "L2", "revision": 1, "deleted": true, "body": {}},
        live("watchlists", "other", 1, json!({})),
        {"kind": "drawing", "id": "no-body", "revision": 1, "deleted": false},
        live("drawing", "ok-2", 1, json!({})),
        "not a document",
    ]);
    let response = account.push(documents).await;
    assert_eq!(statuses(&response), ["accepted", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "accepted", "rejected"]);
    let results = response["results"].as_array().unwrap();
    assert_eq!((results[1]["kind"].as_str(), results[1]["id"].as_str()), (Some("quotes"), Some("main")));
    assert!(results.iter().all(|r| r["status"] != "rejected" || !r["reason"].as_str().unwrap().is_empty()));
    assert_eq!(keys(&account.changes("since=0").await["documents"]).len(), 2);
    assert_eq!(account.summary().await["documents"], 2);

    let whole = account.push_raw(json!("x")).await;
    assert_eq!(whole.status(), 400);
    let too_many = account.push_raw(json!(vec![json!(null); 501])).await;
    assert_eq!(too_many.status(), 400);
}

#[tokio::test]
async fn the_account_limit_refuses_growth_and_accepts_deletes_and_smaller_bodies() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let size = DocumentKind::Layout.document_limit();
    let fits = ACCOUNT_LIMIT / size;
    for chunk in (0..fits).collect::<Vec<_>>().chunks(5) {
        let documents: Vec<Value> = chunk.iter().map(|n| live("layout", &format!("L{n}"), 1, padded(size))).collect();
        assert!(statuses(&account.push(json!(documents)).await).iter().all(|s| *s == "accepted"));
    }
    assert_eq!(account.summary().await["bytes"], (fits * size) as i64);

    let over = account.push(json!([live("layout", "extra", 1, padded(size)), live("ui_state", "main", 1, json!({}))])).await;
    assert_eq!(statuses(&over), ["rejected", "accepted"]);
    assert!(over["results"][0]["reason"].as_str().unwrap().contains("32MB"));

    let grow = account.push(json!([live("drawing", "D1", 1, padded(DocumentKind::Drawing.document_limit()))])).await;
    let room = ACCOUNT_LIMIT - fits * size - 2;
    let expected = if DocumentKind::Drawing.document_limit() <= room { "accepted" } else { "rejected" };
    assert_eq!(statuses(&grow), [expected]);

    let relief = account.push(json!([gone("layout", "L0", 2), live("layout", "L1", 2, json!({"small": true}))])).await;
    assert_eq!(statuses(&relief), ["accepted", "accepted"]);
    let refill = account.push(json!([live("layout", "extra", 1, padded(size))])).await;
    assert_eq!(statuses(&refill), ["accepted"]);
    assert!(account.summary().await["bytes"].as_i64().unwrap() <= ACCOUNT_LIMIT as i64);
}

#[tokio::test]
async fn twenty_concurrent_pushes_of_one_document_leave_the_largest_revision() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let mut revisions: Vec<i64> = (1..=20).collect();
    revisions.rotate_left(7);
    revisions.reverse();
    let tasks: Vec<_> = revisions
        .into_iter()
        .map(|revision| {
            let http = harness.http.clone();
            let url = format!("{}/v1/setup/push", harness.base);
            let token = account.token.clone();
            tokio::spawn(async move {
                let documents = json!({"documents": [live("layout", "L1", revision, json!({"revision": revision}))]});
                let response = http.post(url).bearer_auth(token).json(&documents).send().await.unwrap();
                assert_eq!(response.status(), 200);
                response.json::<Value>().await.unwrap()
            })
        })
        .collect();
    let mut accepted = 0;
    for task in tasks {
        let response = task.await.unwrap();
        match statuses(&response)[0] {
            "accepted" => accepted += 1,
            "stale" => assert!(response["results"][0]["document"]["revision"].as_i64().unwrap() >= 1),
            other => panic!("{other}"),
        }
    }
    assert!(accepted >= 1);
    let changes = account.changes("since=0").await;
    assert_eq!(changes["documents"], json!([live("layout", "L1", 20, json!({"revision": 20}))]));
    assert_eq!(changes["seq"], accepted);
}

#[tokio::test]
async fn deleting_the_account_deletes_its_documents() {
    let harness = Harness::start().await;
    let a = Account::login(&harness, "a").await;
    let b = Account::login(&harness, "b").await;
    a.push(json!([live("layout", "L1", 1, json!({})), gone("drawing", "D1", 2)])).await;
    b.push(json!([live("layout", "L1", 1, json!({}))])).await;
    let removed = harness.http.delete(format!("{}/v1/account", harness.base)).bearer_auth(&a.token).send().await.unwrap();
    assert_eq!(removed.status(), 204);
    let rows = |sql: &'static str| sqlx::query_scalar::<_, i64>(sql).fetch_one(&harness.pool);
    assert_eq!(rows("SELECT COUNT(*) FROM setup_documents").await.unwrap(), 1);
    assert_eq!(rows("SELECT COUNT(*) FROM setup_accounts").await.unwrap(), 1);
    assert_eq!(b.summary().await["documents"], 1);
}

#[tokio::test]
async fn setup_routes_need_a_live_connector_token() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    account.push(json!([live("layout", "L1", 1, json!({}))])).await;
    let call = |method: reqwest::Method, path: &str, token: Option<&str>| {
        let mut request = harness.http.request(method, format!("{}{path}", harness.base)).json(&json!({"documents": []}));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request.send()
    };
    let routes = [(reqwest::Method::POST, "/v1/setup/push"), (reqwest::Method::GET, "/v1/setup/changes"), (reqwest::Method::GET, "/v1/setup/summary")];
    for (method, path) in &routes {
        assert_eq!(call(method.clone(), path, None).await.unwrap().status(), 401, "{path}");
        assert_eq!(call(method.clone(), path, Some(&"a".repeat(43))).await.unwrap().status(), 401, "{path}");
    }
    let revoked = harness.http.delete(format!("{}/v1/auth/token", harness.base)).bearer_auth(&account.token).send().await.unwrap();
    assert_eq!(revoked.status(), 204);
    for (method, path) in &routes {
        assert_eq!(call(method.clone(), path, Some(&account.token)).await.unwrap().status(), 401, "{path}");
    }
}

#[tokio::test]
async fn a_push_larger_than_the_request_limit_is_refused_whole() {
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let documents: Vec<Value> = (0..14).map(|n| live("layout", &format!("L{n}"), 1, padded(DocumentKind::Layout.document_limit()))).collect();
    let response = account.push_raw(json!(documents)).await;
    assert_eq!(response.status(), 413);
    assert_eq!(response.json::<Value>().await.unwrap()["code"], "payload_too_large");
    assert_eq!(account.summary().await["documents"], 0);
}
