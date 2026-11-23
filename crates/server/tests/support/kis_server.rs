use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::BoxFuture;
use futures::{Sink, Stream, StreamExt};
use serde_json::{Value, json};
use server::kis::feed::KisConnect;
use server::kis::master::{MasterDownload, MasterError, MasterMarket};
use server::kis::stream::{Connector, Socket};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

pub const IN_USE_ELSEWHERE: &str = r#"{"header":{"tr_id":null},"body":{"rt_cd":"9","msg_cd":"OPSP8996","msg1":"ALREADY IN USE appkey"}}"#;

pub struct FakeMaster;

pub const KOSPI_TAIL_CHARS: usize = 227;
const KOSDAQ_TAIL_CHARS: usize = 221;

pub fn master_line(market: MasterMarket, code: &str, name: &str) -> Vec<u8> {
    let tail_chars = if market == MasterMarket::Kospi { KOSPI_TAIL_CHARS } else { KOSDAQ_TAIL_CHARS };
    let text = format!("{code:<9}{:<12}{name}{:<width$}", "KR7000000000", "ST", width = tail_chars);
    encoding_rs::EUC_KR.encode(&text).0.into_owned()
}

pub fn archive(lines: &[Vec<u8>]) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut out);
    zip.start_file("code.mst", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
    for line in lines {
        zip.write_all(line).unwrap();
        zip.write_all(b"\r\n").unwrap();
    }
    zip.finish().unwrap();
    out.into_inner()
}

impl MasterDownload for FakeMaster {
    fn download(&self, market: MasterMarket) -> BoxFuture<'static, Result<Vec<u8>, MasterError>> {
        let lines = match market {
            MasterMarket::Kospi => vec![master_line(market, "005930", "삼성전자"), master_line(market, "000660", "SK하이닉스")],
            MasterMarket::Kosdaq => vec![master_line(market, "247540", "에코프로비엠")],
        };
        Box::pin(async move { Ok(archive(&lines)) })
    }
}

struct ChannelSocket {
    incoming: UnboundedReceiver<Result<Message, WsError>>,
    outgoing: UnboundedSender<Message>,
}

impl Stream for ChannelSocket {
    type Item = Result<Message, WsError>;

    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.incoming).poll_next(cx)
    }
}

impl Sink<Message> for ChannelSocket {
    type Error = WsError;

    fn poll_ready(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn start_send(self: std::pin::Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        self.outgoing.unbounded_send(message).map_err(|_| WsError::ConnectionClosed)
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_close(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
        self.outgoing.close_channel();
        std::task::Poll::Ready(Ok(()))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KisControl {
    pub tr_type: String,
    pub tr_id: String,
    pub tr_key: String,
}

#[derive(Clone, Default)]
pub struct KisPeer {
    pub controls: Arc<Mutex<Vec<KisControl>>>,
    pub connections: Arc<Mutex<usize>>,
    pub answer_in_use: Arc<AtomicBool>,
}

impl KisPeer {
    pub fn connect(&self) -> KisConnect {
        let peer = self.clone();
        Arc::new(move || Box::new(peer.clone()))
    }

    pub fn registered(&self) -> Vec<(String, String)> {
        let mut live: Vec<(String, String)> = Vec::new();
        for control in self.controls.lock().unwrap().iter() {
            let item = (control.tr_id.clone(), control.tr_key.clone());
            if control.tr_type == "1" {
                live.push(item);
            } else {
                live.retain(|kept| *kept != item);
            }
        }
        live
    }
}

impl Connector for KisPeer {
    fn connect(&self) -> BoxFuture<'_, Result<Socket, WsError>> {
        *self.connections.lock().unwrap() += 1;
        let (to_client, incoming) = unbounded();
        let (outgoing, mut from_client) = unbounded::<Message>();
        let (controls, answer_in_use) = (self.controls.clone(), self.answer_in_use.clone());
        tokio::spawn(async move {
            while let Some(Message::Text(text)) = from_client.next().await {
                let body: Value = serde_json::from_str(text.as_str()).unwrap();
                let control = KisControl {
                    tr_type: body["header"]["tr_type"].as_str().unwrap().to_owned(),
                    tr_id: body["body"]["input"]["tr_id"].as_str().unwrap().to_owned(),
                    tr_key: body["body"]["input"]["tr_key"].as_str().unwrap().to_owned(),
                };
                controls.lock().unwrap().push(control.clone());
                let reply = if answer_in_use.load(Ordering::SeqCst) {
                    IN_USE_ELSEWHERE.to_owned()
                } else {
                    json!({"header": {"tr_id": control.tr_id, "tr_key": control.tr_key, "encrypt": "N"}, "body": {"rt_cd": "0", "msg_cd": "OPSP0000", "msg1": "SUBSCRIBE SUCCESS"}}).to_string()
                };
                if to_client.unbounded_send(Ok(Message::Text(reply.into()))).is_err() {
                    return;
                }
            }
        });
        Box::pin(async move { Ok(Box::new(ChannelSocket { incoming, outgoing }) as Socket) })
    }
}

