use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};

use openssl::asn1::Asn1Time;
use openssl::bn::{BigNum, MsbOption};
use openssl::hash::MessageDigest;
use openssl::pkey::{PKey, Private};
use openssl::rsa::Rsa;
use openssl::ssl::{SslAcceptor, SslMethod, SslVersion};
use openssl::x509::{X509, X509NameBuilder, extension::{BasicConstraints, KeyUsage, SubjectAlternativeName}};

use super::*;

struct TlsFixture {
    port: u16,
    root: reqwest::Certificate,
    negotiated: Arc<Mutex<Vec<(String, String)>>>,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

fn certificate(key: &PKey<Private>, issuer: Option<(&X509, &PKey<Private>)>) -> X509 {
    let mut name = X509NameBuilder::new().unwrap();
    name.append_entry_by_text("CN", if issuer.is_some() { "localhost" } else { "DART test CA" }).unwrap();
    let name = name.build();
    let mut cert = X509::builder().unwrap();
    cert.set_version(2).unwrap();
    let mut serial = BigNum::new().unwrap();
    serial.rand(128, MsbOption::MAYBE_ZERO, false).unwrap();
    cert.set_serial_number(&serial.to_asn1_integer().unwrap()).unwrap();
    cert.set_subject_name(&name).unwrap();
    cert.set_issuer_name(issuer.map_or(&*name, |(ca, _)| ca.subject_name())).unwrap();
    cert.set_pubkey(key).unwrap();
    cert.set_not_before(&Asn1Time::days_from_now(0).unwrap()).unwrap();
    cert.set_not_after(&Asn1Time::days_from_now(2).unwrap()).unwrap();
    if let Some((ca, _)) = issuer {
        cert.append_extension(BasicConstraints::new().critical().build().unwrap()).unwrap();
        cert.append_extension(KeyUsage::new().digital_signature().key_encipherment().build().unwrap()).unwrap();
        let san = SubjectAlternativeName::new().dns("localhost").build(&cert.x509v3_context(Some(ca), None)).unwrap();
        cert.append_extension(san).unwrap();
    } else {
        cert.append_extension(BasicConstraints::new().critical().ca().build().unwrap()).unwrap();
        cert.append_extension(KeyUsage::new().key_cert_sign().crl_sign().build().unwrap()).unwrap();
    }
    cert.sign(issuer.map_or(key, |(_, key)| key), MessageDigest::sha256()).unwrap();
    cert.build()
}

impl TlsFixture {
    fn start(cipher: &str) -> Self {
        let ca_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let ca = certificate(&ca_key, None);
        let key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let cert = certificate(&key, Some((&ca, &ca_key)));
        let mut acceptor = SslAcceptor::mozilla_intermediate(SslMethod::tls_server()).unwrap();
        acceptor.set_min_proto_version(Some(SslVersion::TLS1_2)).unwrap();
        acceptor.set_max_proto_version(Some(SslVersion::TLS1_2)).unwrap();
        acceptor.set_cipher_list(cipher).unwrap();
        acceptor.set_certificate(&cert).unwrap();
        acceptor.set_private_key(&key).unwrap();
        acceptor.check_private_key().unwrap();
        let acceptor = acceptor.build();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let negotiated = Arc::new(Mutex::new(Vec::new()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let received = requests.clone();
        let (stopping, connections) = (stop.clone(), negotiated.clone());
        let thread = thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                let (socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("loopback accept: {error}"),
                };
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                socket.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
                if let Ok(mut stream) = acceptor.accept(socket) {
                    connections.lock().unwrap().push((stream.ssl().version_str().into(), stream.ssl().current_cipher().unwrap().name().into()));
                    let mut request = Vec::new();
                    let mut byte = [0];
                    while request.len() < 8192 && !request.ends_with(b"\r\n\r\n") {
                        if stream.read_exact(&mut byte).is_err() { break; }
                        request.push(byte[0]);
                    }
                    received.lock().unwrap().push(String::from_utf8(request).unwrap());
                    let body = r#"{"status":"000","corp_code":"00126380"}"#;
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                }
            }
        });
        Self { port, root: reqwest::Certificate::from_der(&ca.to_der().unwrap()).unwrap(), negotiated, requests, stop, thread: Some(thread) }
    }

    fn url(&self, host: &str) -> String { format!("https://{host}:{}", self.port) }

    fn client(&self, host: &str, trusted: bool) -> Client {
        let mut client = Client::new(Secret::new("test-dart-key".into()), self.url(host), self.url(host)).unwrap();
        let mut builder = dart_http_builder().no_proxy();
        if trusted { builder = builder.add_root_certificate(self.root.clone()); }
        client.http = builder.build().unwrap();
        client
    }
}

impl Drop for TlsFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}

#[tokio::test]
async fn dart_connects_to_verified_tls12_rsa_source() {
    let fixture = TlsFixture::start("AES128-GCM-SHA256");
    let client = fixture.client("localhost", true);
    let result = client.response("company.json", &[]).await;
    assert!(result.is_ok(), "DART must connect to a verified TLS 1.2 RSA-only source: {result:?}");
    assert_eq!(result.unwrap()["corp_code"], "00126380");
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].to_ascii_lowercase().contains(concat!("\r\nuser-agent: vallythevally/", env!("CARGO_PKG_VERSION"), "\r\n")));
    assert_eq!(*fixture.negotiated.lock().unwrap(), [("TLSv1.2".into(), "AES128-GCM-SHA256".into())]);
}

#[tokio::test]
async fn dart_rejects_untrusted_certificate_and_wrong_hostname() {
    let fixture = TlsFixture::start("AES128-GCM-SHA256");
    for client in [fixture.client("localhost", false), fixture.client("127.0.0.1", true)] {
        assert_eq!(client.response("company.json", &[]).await, Err(Fault::Failure(Failure::Network)));
    }
    assert!(fixture.negotiated.lock().unwrap().is_empty());
    assert!(fixture.client("localhost", true).response("company.json", &[]).await.is_ok());
}

#[tokio::test]
async fn kind_keeps_rustls_cipher_support_separate_from_dart() {
    for (cipher, supported) in [("AES128-GCM-SHA256", false), ("ECDHE-RSA-AES128-GCM-SHA256", true)] {
        let fixture = TlsFixture::start(cipher);
        let mut client = fixture.client("localhost", true);
        client.kind_http = kind_http_builder().no_proxy().add_root_certificate(fixture.root.clone()).build().unwrap();
        assert_eq!(client.kind_bytes("/common/searchcorpname.do", &[]).await.is_ok(), supported);
        assert!(client.response("company.json", &[]).await.is_ok());
        let requests = fixture.requests.lock().unwrap();
        assert!(requests.last().unwrap().to_ascii_lowercase().contains("\r\nuser-agent: vallythevally/"));
        if supported { assert!(!requests[0].to_ascii_lowercase().contains("\r\nuser-agent:")); }
    }
}
