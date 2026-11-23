use std::process::ExitCode;

pub mod alert;
mod command;
pub mod config;
pub mod listing;
mod render;
mod run;
mod socket;
pub mod wire;

const USAGE: &str = "사용법: collector financials <run|status|start|pause|resume> [...]";

pub fn run(raw_arguments: &[String]) -> ExitCode {
    let Some((subcommand, rest)) = raw_arguments.split_first() else {
        eprintln!("financials: {USAGE}");
        return ExitCode::from(2);
    };
    match subcommand.as_str() {
        "run" => run::run(rest),
        "status" | "start" | "pause" | "resume" => command::run(subcommand, rest),
        unknown => {
            eprintln!("financials: 알 수 없는 하위 명령입니다: {unknown}. {USAGE}");
            ExitCode::from(2)
        }
    }
}
