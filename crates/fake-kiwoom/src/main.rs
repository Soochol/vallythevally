use std::net::SocketAddr;
use std::process::ExitCode;

use fake_kiwoom::FakeKiwoom;

#[tokio::main]
async fn main() -> ExitCode {
    let addr = match parse_bind(std::env::args().skip(1)) {
        Ok(addr) => addr,
        Err(e) => {
            eprintln!("{e}\n사용법: fake-kiwoom [--bind 127.0.0.1:0]");
            return ExitCode::from(2);
        }
    };
    let fake = match FakeKiwoom::bind(addr).await {
        Ok(fake) => fake,
        Err(e) => {
            eprintln!("가짜 키움을 열지 못했습니다: {e}");
            return ExitCode::FAILURE;
        }
    };
    match std::env::var("FAKE_KIWOOM_EXTRA_STOCKS") {
        Err(_) => {}
        Ok(n) => match n.parse() {
            Ok(n) => fake.set_extra_stocks(n),
            Err(_) => {
                eprintln!("FAKE_KIWOOM_EXTRA_STOCKS는 0 이상의 정수입니다: {n:?}");
                return ExitCode::from(2);
            }
        },
    }
    println!("fake-kiwoom listening addr={}", fake.addr);
    std::future::pending::<()>().await;
    ExitCode::SUCCESS
}

fn parse_bind(mut args: impl Iterator<Item = String>) -> Result<SocketAddr, String> {
    let mut addr = SocketAddr::from(([127, 0, 0, 1], 0));
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bind" => {
                let s = args.next().ok_or("--bind 뒤에 주소가 없습니다")?;
                addr = s.parse().map_err(|_| format!("주소 형식이 아닙니다: {s}"))?;
            }
            other => return Err(format!("모르는 인자입니다: {other}")),
        }
    }
    Ok(addr)
}
