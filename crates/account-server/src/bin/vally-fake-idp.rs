use account_server::SystemClock;
use account_server::fake_idp::{ClientCredentials, FakeIdp};
use std::process::ExitCode;
use std::sync::Arc;

fn credentials(prefix: &str) -> Result<ClientCredentials, String> {
    let read = |suffix: &str| {
        let name = format!("VALLY_FAKE_IDP_{prefix}_{suffix}");
        std::env::var(&name).ok().filter(|value| !value.is_empty()).ok_or_else(|| format!("{name}가 필요합니다"))
    };
    Ok(ClientCredentials { id: read("CLIENT_ID")?, secret: read("CLIENT_SECRET")? })
}

#[tokio::main]
async fn main() -> ExitCode {
    let (google, naver) = match credentials("GOOGLE").and_then(|google| Ok((google, credentials("NAVER")?))) {
        Ok(pair) => pair,
        Err(message) => {
            eprintln!("vally-fake-idp: {message}");
            return ExitCode::FAILURE;
        }
    };
    let idp = FakeIdp::start(google, naver, Arc::new(SystemClock)).await;
    println!("{}", serde_json::json!({"fakeIdp": true, "url": idp.url("")}));
    let _ = tokio::signal::ctrl_c().await;
    ExitCode::SUCCESS
}
