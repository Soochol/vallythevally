use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::collector::telegram::{SendFailure, Telegram};

use super::format::FormattedMessage;
use super::model::Severity;

pub trait AlertSink: Send + Sync {
    fn name(&self) -> &'static str;
    fn send<'a>(&'a self, message: &'a FormattedMessage) -> Pin<Box<dyn Future<Output = Result<(), SendFailure>> + Send + 'a>>;
}

pub struct TelegramSink {
    telegram: Arc<Telegram>,
}

impl TelegramSink {
    pub fn new(telegram: Telegram) -> TelegramSink {
        TelegramSink { telegram: Arc::new(telegram) }
    }

    pub fn from_arc(telegram: Arc<Telegram>) -> TelegramSink {
        TelegramSink { telegram }
    }
}

impl AlertSink for TelegramSink {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn send<'a>(&'a self, message: &'a FormattedMessage) -> Pin<Box<dyn Future<Output = Result<(), SendFailure>> + Send + 'a>> {
        Box::pin(async move { self.telegram.send_formatted(&message.html, Some("HTML"), message.silent).await })
    }
}

#[derive(Clone, Default)]
pub struct MemorySink {
    messages: Arc<Mutex<Vec<FormattedMessage>>>,
    fail: Arc<Mutex<bool>>,
}

impl MemorySink {
    pub fn new() -> MemorySink {
        MemorySink::default()
    }

    pub fn messages(&self) -> Vec<FormattedMessage> {
        self.messages.lock().expect("메모리 싱크 잠금").clone()
    }

    pub fn set_fail(&self, fail: bool) {
        *self.fail.lock().expect("메모리 싱크 실패 설정 잠금") = fail;
    }
}

impl AlertSink for MemorySink {
    fn name(&self) -> &'static str {
        "memory"
    }

    fn send<'a>(&'a self, message: &'a FormattedMessage) -> Pin<Box<dyn Future<Output = Result<(), SendFailure>> + Send + 'a>> {
        let messages = self.messages.clone();
        let fail = *self.fail.lock().expect("메모리 싱크 실패 확인 잠금");
        Box::pin(async move {
            if fail {
                return Err(SendFailure::Status(500));
            }
            messages.lock().expect("메모리 싱크 기록 잠금").push(message.clone());
            Ok(())
        })
    }
}

#[derive(Clone)]
pub struct RouteRule {
    pub min_severity: Severity,
    pub sink: Arc<dyn AlertSink>,
}

#[derive(Clone, Default)]
pub struct AlertRouter {
    rules: Vec<RouteRule>,
}

impl AlertRouter {
    pub fn single(sink: Arc<dyn AlertSink>) -> AlertRouter {
        AlertRouter { rules: vec![RouteRule { min_severity: Severity::P3Info, sink }] }
    }

    pub fn with_rule(mut self, min_severity: Severity, sink: Arc<dyn AlertSink>) -> AlertRouter {
        self.rules.push(RouteRule { min_severity, sink });
        self
    }

    pub async fn deliver(&self, message: &FormattedMessage) -> bool {
        let mut any_delivered = false;
        for rule in &self.rules {
            if message.severity < rule.min_severity {
                continue;
            }
            match rule.sink.send(message).await {
                Ok(()) => any_delivered = true,
                Err(failure) => tracing::warn!(sink = rule.sink.name(), %failure, "수집 경보를 텔레그램으로 보내지 못했습니다"),
            }
        }
        any_delivered
    }
}
