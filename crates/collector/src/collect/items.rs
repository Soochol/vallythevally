use std::collections::HashSet;
use std::fmt;

use domain::StockCode;

pub const MAX_ITEMS: usize = 200;
pub const REGISTRATION_SUFFIX: &str = "_AL";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemsError {
    Missing,
    Malformed(String),
    Repeated(String),
    TooMany(usize),
}

impl fmt::Display for ItemsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ItemsError::Missing => write!(formatter, "--items가 필요합니다(예: --items 005930,000660)"),
            ItemsError::Malformed(text) => write!(formatter, "--items에 종목코드가 아닌 값이 있습니다: {text:?}"),
            ItemsError::Repeated(code) => write!(formatter, "--items에 같은 종목이 두 번 있습니다: {code}"),
            ItemsError::TooMany(count) => write!(formatter, "--items는 {MAX_ITEMS}개까지입니다({count}개를 적었습니다)"),
        }
    }
}

impl std::error::Error for ItemsError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Items(Vec<StockCode>);

impl Items {
    pub fn parse(text: Option<&str>) -> Result<Items, ItemsError> {
        let text = text.ok_or(ItemsError::Missing)?;
        let mut seen = HashSet::new();
        let mut codes = Vec::new();
        for part in text.split(',') {
            let code = StockCode::parse(part).map_err(|_| ItemsError::Malformed(part.to_owned()))?;
            if !seen.insert(code) {
                return Err(ItemsError::Repeated(part.to_owned()));
            }
            codes.push(code);
        }
        if codes.len() > MAX_ITEMS {
            return Err(ItemsError::TooMany(codes.len()));
        }
        Ok(Items(codes))
    }

    pub fn registrations(&self) -> Vec<String> {
        self.0.iter().map(|code| format!("{}{REGISTRATION_SUFFIX}", code.as_str())).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(count: usize) -> String {
        (0..count).map(|number| format!("{:06}", number + 1)).collect::<Vec<_>>().join(",")
    }

    #[test]
    fn registers_each_code_as_an_integrated_item_in_order() {
        let items = Items::parse(Some("005930,000660,03481K")).unwrap();
        assert_eq!(items.registrations(), ["005930_AL", "000660_AL", "03481K_AL"]);
    }

    #[test]
    fn rejects_malformed_repeated_empty_and_missing() {
        assert_eq!(Items::parse(Some("5930")), Err(ItemsError::Malformed("5930".into())));
        assert_eq!(Items::parse(Some("005930,abc123")), Err(ItemsError::Malformed("abc123".into())));
        assert_eq!(Items::parse(Some("005930,000660,005930")), Err(ItemsError::Repeated("005930".into())));
        assert_eq!(Items::parse(Some("005930,")), Err(ItemsError::Malformed(String::new())));
        assert_eq!(Items::parse(Some("")), Err(ItemsError::Malformed(String::new())));
        assert_eq!(Items::parse(None), Err(ItemsError::Missing));
    }

    #[test]
    fn allows_one_to_two_hundred() {
        assert_eq!(Items::parse(Some(&codes(1))).unwrap().registrations().len(), 1);
        assert_eq!(Items::parse(Some(&codes(200))).unwrap().registrations().len(), 200);
        assert_eq!(Items::parse(Some(&codes(201))), Err(ItemsError::TooMany(201)));
    }
}
