use std::path::Path;

use domain::{KstDate, TimeOfDay};
use futures::future::BoxFuture;
use serde_json::Value;
use server::clock::Clock;
use server::kiwoom::rest::KiwoomRest;
use server::shared_data::Broker;

use crate::protocol::KeyName;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobError(pub String);

impl std::fmt::Display for JobError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

pub type JobFuture<'a> = BoxFuture<'a, Result<(), JobError>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobWindow {
    pub start: TimeOfDay,
    pub end: TimeOfDay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slice {
    pub index: u32,
    pub count: u32,
}

impl Slice {
    pub const WHOLE: Slice = Slice { index: 0, count: 1 };

    pub fn owns(self, unit: u32) -> bool {
        unit % self.count.max(1) == self.index
    }
}

pub enum Market<'a> {
    Kiwoom(&'a KiwoomRest),
    Kis,
}

pub struct JobCall<'a> {
    pub observation_date: KstDate,
    pub slice: Slice,
    pub market: Market<'a>,
    pub shared_dir: &'a Path,
    pub key: &'a KeyName,
    pub clock: &'a Clock,
    pub options: &'a Value,
}

pub trait SharedJob: Send + Sync {
    fn window(&self) -> JobWindow;
    fn brokers(&self) -> &'static [Broker];
    fn check_options(&self, options: &Value) -> Result<(), String>;
    fn run<'a>(&'a self, call: JobCall<'a>) -> JobFuture<'a>;
}
