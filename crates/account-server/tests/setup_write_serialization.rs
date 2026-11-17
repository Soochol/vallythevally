mod common;

use common::*;
use serde_json::{Value, json};
use setup::{ACCOUNT_LIMIT, DocumentKind};
use std::collections::{BTreeMap, BTreeSet};

const CHANGES_PAGE: usize = 7;

struct Account {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl Account {
    async fn login(harness: &Harness, subject: &str) -> Account {
        harness.idp.set_subject(subject);
        let (token, _) = harness.token_for("google", subject).await;
        Account { http: harness.http.clone(), base: harness.base.clone(), token }
    }

    async fn push(&self, documents: Vec<Value>) -> Value {
        let response = self.http.post(format!("{}/v1/setup/push", self.base)).bearer_auth(&self.token).json(&json!({ "documents": documents })).send().await.unwrap();
        assert_eq!(response.status(), 200);
        response.json().await.unwrap()
    }

    async fn get(&self, path: &str) -> Value {
        let response = self.http.get(format!("{}{path}", self.base)).bearer_auth(&self.token).send().await.unwrap();
        assert_eq!(response.status(), 200);
        response.json().await.unwrap()
    }

    async fn summary(&self) -> Value {
        self.get("/v1/setup/summary").await
    }

    async fn all_documents(&self) -> Vec<Value> {
        let mut since = 0;
        let mut documents = Vec::new();
        loop {
            let page = self.get(&format!("/v1/setup/changes?since={since}&limit={CHANGES_PAGE}")).await;
            documents.extend(page["documents"].as_array().unwrap().iter().cloned());
            since = page["seq"].as_i64().unwrap();
            if !page["more"].as_bool().unwrap() {
                return documents;
            }
        }
    }
}

async fn push_all_at_once(account: &Account, pushes: Vec<Vec<Value>>) -> Vec<Value> {
    let tasks: Vec<_> = pushes
        .into_iter()
        .map(|documents| {
            let account = Account { http: account.http.clone(), base: account.base.clone(), token: account.token.clone() };
            tokio::spawn(async move { account.push(documents).await })
        })
        .collect();
    let mut responses = Vec::new();
    for task in tasks {
        responses.push(task.await.unwrap());
    }
    responses
}

fn live(kind: &str, id: &str, revision: i64, body: Value) -> Value {
    json!({"kind": kind, "id": id, "revision": revision, "deleted": false, "body": body})
}

fn padded(bytes: usize) -> Value {
    json!({ "pad": "x".repeat(bytes - r#"{"pad":""}"#.len()) })
}

fn statuses(response: &Value) -> Vec<&str> {
    response["results"].as_array().unwrap().iter().map(|result| result["status"].as_str().unwrap()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_pushes_hand_out_each_sequence_number_once_and_lose_no_document() {
    const PUSHES: usize = 24;
    const DOCUMENTS_PER_PUSH: usize = 3;
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let pushes: Vec<Vec<Value>> = (0..PUSHES)
        .map(|push| (0..DOCUMENTS_PER_PUSH).map(|n| live("drawing", &format!("D{push}-{n}"), 1, json!({"push": push, "n": n}))).collect())
        .collect();

    let responses = push_all_at_once(&account, pushes).await;

    let total = (PUSHES * DOCUMENTS_PER_PUSH) as i64;
    let mut seqs = Vec::new();
    for response in &responses {
        assert_eq!(statuses(response), ["accepted"; DOCUMENTS_PER_PUSH]);
        seqs.extend(response["results"].as_array().unwrap().iter().map(|result| result["seq"].as_i64().unwrap()));
    }
    seqs.sort_unstable();
    assert_eq!(seqs, (1..=total).collect::<Vec<_>>());

    let stored = account.all_documents().await;
    let ids: BTreeSet<&str> = stored.iter().map(|document| document["id"].as_str().unwrap()).collect();
    assert_eq!(stored.len() as i64, total);
    assert_eq!(ids.len() as i64, total);
    assert_eq!(account.summary().await["seq"], total);
    assert_eq!(account.summary().await["documents"], total);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_pushes_of_shuffled_revisions_leave_the_largest_revision_of_each_document() {
    const REVISIONS: i64 = 16;
    const IDS: [&str; 3] = ["L1", "L2", "L3"];
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let pushes: Vec<Vec<Value>> = (0..REVISIONS)
        .map(|n| {
            let revision = (n * 7) % REVISIONS + 1;
            IDS.iter().map(|id| live("layout", id, revision, json!({"revision": revision}))).collect()
        })
        .collect();

    let responses = push_all_at_once(&account, pushes).await;

    let accepted = responses.iter().flat_map(|response| statuses(response)).filter(|status| *status == "accepted").count();
    for response in &responses {
        for status in statuses(response) {
            assert!(["accepted", "stale"].contains(&status), "{status}");
        }
    }
    let stored: BTreeMap<String, Value> = account.all_documents().await.into_iter().map(|document| (document["id"].as_str().unwrap().to_owned(), document)).collect();
    assert_eq!(stored.keys().map(String::as_str).collect::<Vec<_>>(), IDS);
    for id in IDS {
        assert_eq!(stored[id], live("layout", id, REVISIONS, json!({"revision": REVISIONS})));
    }
    assert_eq!(account.summary().await["seq"], accepted as i64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_growth_just_below_the_account_limit_never_passes_it() {
    const CONTENDERS: usize = 8;
    let harness = Harness::start().await;
    let account = Account::login(&harness, "a").await;
    let size = DocumentKind::Layout.document_limit();
    let fits = ACCOUNT_LIMIT / size;
    let room_for = 2;
    let filled: Vec<usize> = (0..fits - room_for).collect();
    for chunk in filled.chunks(5) {
        let documents = chunk.iter().map(|n| live("layout", &format!("F{n}"), 1, padded(size))).collect();
        assert!(statuses(&account.push(documents).await).iter().all(|status| *status == "accepted"));
    }
    let before = account.summary().await;
    assert_eq!(before["bytes"], (filled.len() * size) as i64);

    let pushes = (0..CONTENDERS).map(|n| vec![live("layout", &format!("N{n}"), 1, padded(size))]).collect();
    let responses = push_all_at_once(&account, pushes).await;

    let outcomes: Vec<&str> = responses.iter().flat_map(|response| statuses(response)).collect();
    let accepted = outcomes.iter().filter(|status| **status == "accepted").count();
    assert_eq!(accepted, room_for);
    assert_eq!(outcomes.iter().filter(|status| **status == "rejected").count(), CONTENDERS - room_for);
    let after = account.summary().await;
    assert_eq!(after["bytes"].as_i64().unwrap(), before["bytes"].as_i64().unwrap() + (accepted * size) as i64);
    assert!(after["bytes"].as_i64().unwrap() <= ACCOUNT_LIMIT as i64);
    assert_eq!(after["seq"].as_i64().unwrap(), before["seq"].as_i64().unwrap() + accepted as i64);
}
