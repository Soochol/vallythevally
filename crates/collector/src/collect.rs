use std::process::ExitCode;

use crate::args::{ArgSpec, Arguments};

pub mod config;
pub mod items;
pub mod output;
pub mod session;
pub mod start;
pub mod ws;

#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod testing;

const SPEC: ArgSpec = ArgSpec {
    value_options: &["items"],
    flag_options: &[],
};

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let arguments = match Arguments::parse(raw_arguments, &SPEC) {
        Ok(arguments) => arguments,
        Err(error) => {
            eprintln!("collect: {error}");
            return ExitCode::from(2);
        }
    };
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
