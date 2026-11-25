use std::process::ExitCode;

use collector::{build, collect, finalize, financials, probe_tr, quotes, serve, shared, supervise, verify};

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = arguments.split_first() else {
        eprintln!("사용법: collector <collect|build|verify|serve|finalize|quotes|financials|supervise|shared|status|restart-window|probe-tr> [--data <폴더>] ...");
        return ExitCode::from(2);
    };
    match command.as_str() {
        "collect" => collect::run(rest),
        "build" => build::run(rest),
        "verify" => verify::run(rest),
        "serve" => serve::run(rest),
        "finalize" => finalize::run(rest),
        "quotes" => quotes::run(rest),
        "financials" => financials::run(rest),
        "supervise" => supervise::run(rest),
        "shared" => shared::child::run(rest),
        "status" => supervise::run_status(rest),
        "restart-window" => supervise::run_restart_window(rest),
        "probe-tr" => probe_tr::run(rest),
        unknown => {
            eprintln!("알 수 없는 하위 명령입니다: {unknown}");
            ExitCode::from(2)
        }
    }
}
