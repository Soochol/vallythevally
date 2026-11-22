use serde_json::value::RawValue;

use crate::error::ApiError;
use crate::setup_store::{Checked, Outcome, SetupDocument};
use crate::store::Store;

pub enum SetupPut {
    Saved,
    Stale(SetupDocument),
    AccountFull(String),
    Invalid(String),
    AccountGone,
}

pub async fn put(store: &Store, now_millis: i64, account_id: &str, document: &SetupDocument) -> Result<SetupPut, sqlx::Error> {
    let text = serde_json::to_string(document).expect("셋업 문서는 언제나 직렬화된다");
    let raw = RawValue::from_string(text).expect("직렬화한 문서는 JSON이다");
    let checked = match Checked::parse(&raw, now_millis) {
        Ok(checked) => checked,
        Err(reason) => return Ok(SetupPut::Invalid(reason)),
    };
    let pushed = match store.push_documents(account_id, &[&checked]).await {
        Ok(pushed) => pushed,
        Err(error) if ApiError::is_foreign_key_violation(&error) => return Ok(SetupPut::AccountGone),
        Err(error) => return Err(error),
    };
    Ok(match pushed.outcomes.into_iter().next().expect("문서 하나를 보내면 결과도 하나다") {
        Outcome::Accepted { .. } => SetupPut::Saved,
        Outcome::Stale(stored) => SetupPut::Stale(stored),
        Outcome::Rejected(reason) => SetupPut::AccountFull(reason),
    })
}
