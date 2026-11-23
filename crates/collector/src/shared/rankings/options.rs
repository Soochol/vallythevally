use serde::Deserialize;
use serde_json::{Value, json};
use server::api::{Ranking, RankingPages};
use server::market_source::rankings::condition_key;
use server::shared_data::{DEFAULT_PAGES, default_rankings};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOptions {
    #[serde(default)]
    variants: Option<Vec<Value>>,
    #[serde(default)]
    pages: Option<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Condition {
    pub key: String,
    pub ranking: Ranking,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct RankingsOptions {
    pub conditions: Vec<Condition>,
    pub pages: u8,
}

fn condition_of(ranking: Ranking) -> Condition {
    Condition { key: condition_key(&ranking), ranking }
}

fn variant_of(value: &Value) -> Result<Ranking, String> {
    let Value::Object(fields) = value else { return Err("variants의 항목은 객체여야 합니다".to_owned()) };
    let mut fields = fields.clone();
    fields.insert("excludes".to_owned(), json!({"etfEtn": false, "preferred": false}));
    serde_json::from_value(Value::Object(fields)).map_err(|error| format!("variants의 항목이 순위 조건이 아닙니다: {error}"))
}

pub(super) fn options_of(options: &Value) -> Result<RankingsOptions, String> {
    let raw = match options.is_null() {
        true => RawOptions { variants: None, pages: None },
        false => serde_json::from_value::<RawOptions>(options.clone()).map_err(|error| error.to_string())?,
    };
    let pages = raw.pages.unwrap_or(DEFAULT_PAGES);
    RankingPages::try_from(pages).map_err(str::to_owned)?;
    let rankings = match raw.variants {
        None => default_rankings(),
        Some(variants) if variants.is_empty() => return Err("variants가 비어 있습니다".to_owned()),
        Some(variants) => variants.iter().map(variant_of).collect::<Result<Vec<_>, _>>()?,
    };
    let conditions: Vec<Condition> = rankings.into_iter().map(condition_of).collect();
    for (index, condition) in conditions.iter().enumerate() {
        if conditions[..index].iter().any(|earlier| earlier.key == condition.key) {
            return Err(format!("같은 조건이 두 번 적혀 있습니다: {}", condition.key));
        }
    }
    Ok(RankingsOptions { conditions, pages })
}
