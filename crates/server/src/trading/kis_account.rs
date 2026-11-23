use std::fmt;

use crate::config::Secret;

const CANO_DIGITS: usize = 8;
const PRODUCT_DIGITS: usize = 2;
const TAIL_DIGITS: usize = 2;
const HTS_ID_MAX_CHARS: usize = 16;

pub const ACCOUNT_SHAPE_PROBLEM: &str = "계좌번호는 12345678-01 모양(8자리-2자리 숫자)이어야 합니다";
pub const HTS_ID_SHAPE_PROBLEM: &str = "HTS ID는 공백 없는 영문자·숫자 16자까지입니다";

#[derive(Clone, PartialEq, Eq)]
pub struct KisAccountNumber {
    cano: Secret<String>,
    product: Secret<String>,
}

impl KisAccountNumber {
    pub fn parse(text: &str) -> Result<KisAccountNumber, &'static str> {
        let (cano, product) = text.trim().split_once('-').ok_or(ACCOUNT_SHAPE_PROBLEM)?;
        let digits = |part: &str, len: usize| part.len() == len && part.bytes().all(|b| b.is_ascii_digit());
        if !digits(cano, CANO_DIGITS) || !digits(product, PRODUCT_DIGITS) {
            return Err(ACCOUNT_SHAPE_PROBLEM);
        }
        Ok(KisAccountNumber { cano: Secret::new(cano.to_owned()), product: Secret::new(product.to_owned()) })
    }

    pub fn cano(&self) -> &str {
        self.cano.expose()
    }

    pub fn product(&self) -> &str {
        self.product.expose()
    }

    pub fn digits(&self) -> Secret<String> {
        Secret::new(format!("{}{}", self.cano(), self.product()))
    }

    pub fn stored(&self) -> String {
        format!("{}-{}", self.cano(), self.product())
    }

    pub fn tail(&self) -> String {
        self.cano()[CANO_DIGITS - TAIL_DIGITS..].to_owned()
    }

    pub fn masked(&self) -> String {
        format!("****-**{}", self.tail())
    }
}

impl fmt::Debug for KisAccountNumber {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("KisAccountNumber([가림])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct HtsId(Secret<String>);

impl HtsId {
    pub fn parse(text: &str) -> Result<HtsId, &'static str> {
        let text = text.trim();
        let valid = !text.is_empty() && text.chars().count() <= HTS_ID_MAX_CHARS && text.chars().all(|c| c.is_ascii_alphanumeric());
        if valid { Ok(HtsId(Secret::new(text.to_owned()))) } else { Err(HTS_ID_SHAPE_PROBLEM) }
    }

    pub fn expose(&self) -> &str {
        self.0.expose()
    }
}

impl fmt::Debug for HtsId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HtsId([가림])")
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KisAccountSettings {
    pub number: Option<KisAccountNumber>,
    pub hts_id: Option<HtsId>,
}

impl KisAccountSettings {
    pub fn read(number: Option<&str>, hts_id: Option<&str>) -> Result<KisAccountSettings, &'static str> {
        let present = |text: Option<&str>| text.map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
        Ok(KisAccountSettings { number: present(number).as_deref().map(KisAccountNumber::parse).transpose()?, hts_id: present(hts_id).as_deref().map(HtsId::parse).transpose()? })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kis_account_number_is_eight_digits_dash_two_and_shows_only_the_tail_of_the_eight() {
        let number = KisAccountNumber::parse(" 50012356-01 ").unwrap();
        assert_eq!((number.cano(), number.product(), number.tail(), number.masked()), ("50012356", "01", "56".to_owned(), "****-**56".to_owned()));
        assert_eq!(number.digits().expose(), "5001235601");
        assert_eq!(number.stored(), "50012356-01");
        assert!(!format!("{number:?}").contains("5001"));
        for bad in ["", "5001235601", "5001235-601", "50012356-1", "5001235a-01", "50012356-01-2", "500123567-01"] {
            assert_eq!(KisAccountNumber::parse(bad), Err(ACCOUNT_SHAPE_PROBLEM), "{bad}");
        }
    }

    #[test]
    fn an_hts_id_is_short_alphanumeric_and_blank_settings_read_as_absent() {
        assert!(HtsId::parse("fakeuser01").is_ok());
        for bad in ["", "has space", "한글아이디", "x".repeat(17).as_str()] {
            assert_eq!(HtsId::parse(bad), Err(HTS_ID_SHAPE_PROBLEM), "{bad}");
        }
        assert_eq!(KisAccountSettings::read(Some(" "), None), Ok(KisAccountSettings::default()));
        assert_eq!(KisAccountSettings::read(Some("1234-1"), None).unwrap_err(), ACCOUNT_SHAPE_PROBLEM);
    }
}
