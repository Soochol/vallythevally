use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::PathBuf;

use crate::DEFAULT_DATA_DIR;

const DATA_OPTION: &str = "data";

#[derive(Debug, Clone, Copy)]
pub struct ArgSpec {
    pub value_options: &'static [&'static str],
    pub flag_options: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgError {
    NotAnOption(String),
    Unknown(String),
    MissingValue(String),
    Repeated(String),
}

impl fmt::Display for ArgError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ArgError::NotAnOption(text) => write!(formatter, "옵션이 아닌 인수입니다: {text}"),
            ArgError::Unknown(name) => write!(formatter, "알 수 없는 인수입니다: --{name}"),
            ArgError::MissingValue(name) => write!(formatter, "--{name}에 값이 없습니다"),
            ArgError::Repeated(name) => write!(formatter, "--{name}을 두 번 적었습니다"),
        }
    }
}

impl std::error::Error for ArgError {}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Arguments {
    values: HashMap<String, String>,
    flags: HashSet<String>,
}

impl Arguments {
    pub fn parse(raw: &[String], spec: &ArgSpec) -> Result<Arguments, ArgError> {
        let mut parsed = Arguments::default();
        let mut remaining = raw.iter().peekable();
        while let Some(token) = remaining.next() {
            let name = token
                .strip_prefix("--")
                .ok_or_else(|| ArgError::NotAnOption(token.clone()))?;
            if name == DATA_OPTION || spec.value_options.contains(&name) {
                let value = remaining
                    .next_if(|next| !next.is_empty() && !next.starts_with("--"))
                    .ok_or_else(|| ArgError::MissingValue(name.to_string()))?;
                if parsed.values.insert(name.to_string(), value.clone()).is_some() {
                    return Err(ArgError::Repeated(name.to_string()));
                }
            } else if spec.flag_options.contains(&name) {
                if !parsed.flags.insert(name.to_string()) {
                    return Err(ArgError::Repeated(name.to_string()));
                }
            } else {
                return Err(ArgError::Unknown(name.to_string()));
            }
        }
        Ok(parsed)
    }

    pub fn data_dir(&self) -> PathBuf {
        self.value(DATA_OPTION).map_or_else(|| PathBuf::from(DEFAULT_DATA_DIR), PathBuf::from)
    }

    pub fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    pub fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: ArgSpec = ArgSpec {
        value_options: &["items"],
        flag_options: &["follow"],
    };

    fn parse(tokens: &[&str]) -> Result<Arguments, ArgError> {
        let owned: Vec<String> = tokens.iter().map(|token| token.to_string()).collect();
        Arguments::parse(&owned, &SPEC)
    }

    #[test]
    fn reads_values_and_flags() {
        let arguments = parse(&["--data", "out", "--follow", "--items", "005930"]).unwrap();
        assert_eq!(arguments.data_dir(), PathBuf::from("out"));
        assert_eq!(arguments.value("items"), Some("005930"));
        assert!(arguments.flag("follow"));
    }

    #[test]
    fn data_dir_defaults() {
        assert_eq!(parse(&[]).unwrap().data_dir(), PathBuf::from("data/hoga"));
    }

    #[test]
    fn rejects_unknown_missing_and_repeated() {
        assert_eq!(parse(&["--nope"]), Err(ArgError::Unknown("nope".into())));
        assert_eq!(parse(&["--items"]), Err(ArgError::MissingValue("items".into())));
        assert_eq!(
            parse(&["--items", "--follow"]),
            Err(ArgError::MissingValue("items".into()))
        );
        assert_eq!(parse(&["--data", ""]), Err(ArgError::MissingValue("data".into())));
        assert_eq!(parse(&["--follow", "--follow"]), Err(ArgError::Repeated("follow".into())));
        assert_eq!(parse(&["stray"]), Err(ArgError::NotAnOption("stray".into())));
    }
}
