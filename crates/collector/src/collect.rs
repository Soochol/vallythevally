use std::process::ExitCode;

use crate::args::{ArgSpec, Arguments};
use crate::protocol::KeyName;

pub mod child;
pub mod config;
pub mod items;
pub mod link;
pub mod output;
pub mod registry;
pub mod session;
pub mod start;
pub mod ws;

#[cfg(test)]
mod child_tests;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod testing;

const SPEC: ArgSpec = ArgSpec {
    value_options: &["items", "key"],
    flag_options: &["child"],
};

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &SPEC) {
        Ok(arguments) => arguments,
        Err(error) => {
            eprintln!("collect: {error}");
            return ExitCode::from(2);
        }
    };
    if arguments.flag("child") {
        return run_child(&arguments);
    }
    if arguments.value("key").is_some() {
        eprintln!("collect: --key는 --child와 함께만 씁니다");
        return ExitCode::from(2);
    }
    let items = match items::Items::parse(arguments.value("items")) {
        Ok(items) => items,
        Err(error) => {
            eprintln!("collect: {error}");
            return ExitCode::from(2);
        }
    };
    let config = match config::CollectorConfig::load(&config::process_variables()) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("collect: {error}");
            return ExitCode::from(2);
        }
    };
    start::run_collector(&config, arguments.data_dir(), &items)
}

fn run_child(arguments: &Arguments) -> ExitCode {
    if arguments.value("items").is_some() {
        eprintln!("collect: --child는 --items를 받지 않습니다. 종목은 데몬이 register 명령으로 보냅니다");
        return ExitCode::from(2);
    }
    let Some(key_text) = arguments.value("key") else {
        eprintln!("collect: --child에는 --key <이름>이 필요합니다");
        return ExitCode::from(2);
    };
    match KeyName::parse(key_text) {
        Ok(key) => child::run(key, arguments.data_dir()),
        Err(error) => {
            eprintln!("collect: --key: {error}");
            ExitCode::from(2)
        }
    }
}
