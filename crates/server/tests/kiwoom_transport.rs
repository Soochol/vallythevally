use std::sync::Arc;

use axum::{Router, body::Body, extract::State, http::{HeaderMap, Uri}, response::Response, routing::post};
use server::config::Secret;
use server::kiwoom::{api::ApiId, rest::ContKey, transport::{HttpRequest, ReqwestTransport, Transport}};
use tokio::sync::{Mutex, mpsc};

struct Recorded {
    requests: mpsc::Sender<(Uri, HeaderMap, String)>,
    continuation: Mutex<bool>,
}

async fn receive(State(recorded): State<Arc<Recorded>>, uri: Uri, headers: HeaderMap, body: String) -> Response {
    recorded.requests.send((uri, headers, body)).await.unwrap();
    let mut continuation = recorded.continuation.lock().await;
    let first = *continuation;
    *continuation = false;
    Response::builder().status(if first { 200 } else { 503 }).header("cont-yn", if first { "Y" } else { "N" }).header("next-key", "page-two").body(Body::from(r#"{"return_code":0}"#)).unwrap()
}

#[tokio::test]
async fn reqwest_adapter_preserves_endpoint_credentials_continuation_status_and_body() {
    let (requests, mut observed) = mpsc::channel(2);
    let state = Arc::new(Recorded { requests, continuation: Mutex::new(true) });
    let app = Router::new().route("/{*path}", post(receive)).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let transport = ReqwestTransport::new(format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });

    let response = transport.send(HttpRequest { api_id: ApiId::Ka10081, token: Some(Secret::new("adapter-token".into())), cont: Some(ContKey::new("page-one")), body: Secret::new(r#"{"stk_cd":"005930_AL"}"#.into()) }).await.unwrap();
    let (uri, headers, body) = observed.recv().await.unwrap();
    assert_eq!(uri.path(), "/api/dostk/chart");
    assert_eq!(headers["api-id"], "ka10081");
    assert_eq!(headers["authorization"], "Bearer adapter-token");
    assert_eq!(headers["content-type"], "application/json;charset=UTF-8");
    assert_eq!((headers["cont-yn"].to_str().unwrap(), headers["next-key"].to_str().unwrap()), ("Y", "page-one"));
    assert_eq!(body, r#"{"stk_cd":"005930_AL"}"#);
    assert_eq!((response.status, response.next_key.as_deref(), response.body.as_str()), (200, Some("page-two"), r#"{"return_code":0}"#));

    let response = transport.send(HttpRequest { api_id: ApiId::Au10001, token: None, cont: None, body: Secret::new(r#"{"appkey":"adapter-key","secretkey":"adapter-secret"}"#.into()) }).await.unwrap();
    let (uri, headers, body) = observed.recv().await.unwrap();
    assert_eq!(uri.path(), "/oauth2/token");
    assert_eq!(headers["api-id"], "au10001");
    assert!(!headers.contains_key("authorization"));
    assert!(!headers.contains_key("cont-yn"));
    assert!(!headers.contains_key("next-key"));
    assert_eq!(body, r#"{"appkey":"adapter-key","secretkey":"adapter-secret"}"#);
    assert_eq!((response.status, response.next_key), (503, None));
    server.abort();
}
