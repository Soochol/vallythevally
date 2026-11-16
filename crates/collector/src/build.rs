use std::process::ExitCode;

use crate::args::{ArgSpec, Arguments};

const SPEC: ArgSpec = ArgSpec {
    value_options: &[],
    flag_options: &[],
};

pub fn run(raw_arguments: &[String]) -> ExitCode {
    if let Err(error) = Arguments::parse(raw_arguments, &SPEC) {
        eprintln!("build: {error}");
        return ExitCode::from(2);
    }
    eprintln!("build: 아직 구현되지 않았습니다");
    ExitCode::FAILURE
}
