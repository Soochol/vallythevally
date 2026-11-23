use super::*;

pub(super) fn clock_at(start: &str) -> Clock {
    let number = |range: std::ops::Range<usize>| start[range].parse::<u32>().unwrap();
    Clock::fake(kst(KstDate::parse_yyyymmdd(&start[..8]).unwrap(), number(8..10), number(10..12), number(12..14)))
}

pub(super) fn listing(stocks: &[(&str, bool)]) -> Vec<domain::SymbolInfo> {
    stocks.iter().map(|(code, preferred)| symbol(code, *preferred)).collect()
}

pub(super) fn directory(listing: &[domain::SymbolInfo]) -> Arc<server::symbols::SymbolDirectory> {
    let symbols = Arc::new(server::symbols::SymbolDirectory::default());
    symbols.replace(server::symbols::Directory::build(listing.to_vec()));
    symbols
}

pub(super) struct Collector {
    runtime: Option<tokio::runtime::Runtime>,
    pub service: Arc<Financials>,
    pub clock: Clock,
    listing: Vec<domain::SymbolInfo>,
    reader: axum::Router,
}

impl Collector {
    pub(super) async fn open(fake: &Fake, dir: &std::path::Path, start: &str, stocks: &[(&str, bool)]) -> Self {
        Self::open_with(Some(fake.client()), dir, start, stocks).await
    }

    pub(super) async fn open_spaced(fake: &Fake, dir: &std::path::Path, start: &str, stocks: &[(&str, bool)], spacing: Duration) -> Self {
        let client = Client::with_spacing(Secret::new(KEY.into()), fake.url.clone(), fake.url.clone(), spacing).unwrap();
        Self::open_with(Some(client), dir, start, stocks).await
    }

    pub(super) async fn open_without_client(dir: &std::path::Path, start: &str, stocks: &[(&str, bool)]) -> Self {
        Self::open_with(None, dir, start, stocks).await
    }

    async fn open_with(client: Option<Client>, dir: &std::path::Path, start: &str, stocks: &[(&str, bool)]) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let (path, clock) = (dir.join("run/financials.db"), clock_at(start));
        let service = {
            let clock = clock.clone();
            runtime.spawn(async move { Financials::new(client, Store::open_for_collection(&path).await.unwrap(), clock) }).await.unwrap()
        };
        let listing = listing(stocks);
        let reader = server::financials::routes(service.clone(), directory(&listing));
        Self { runtime: Some(runtime), service, clock, listing, reader }
    }

    pub(super) fn attach(service: Arc<Financials>, clock: Clock, stocks: &[(&str, bool)]) -> Self {
        let listing = listing(stocks);
        let reader = server::financials::routes(service.clone(), directory(&listing));
        Self { runtime: None, service, clock, listing, reader }
    }

    pub(super) async fn run<T: Send + 'static>(&self, work: impl std::future::Future<Output = T> + Send + 'static) -> T {
        match &self.runtime {
            Some(runtime) => runtime.spawn(work).await.unwrap(),
            None => tokio::spawn(work).await.unwrap(),
        }
    }

    pub(super) async fn start_automatic(&self) -> (tokio::sync::watch::Sender<Option<Vec<domain::SymbolInfo>>>, tokio::task::JoinHandle<()>) {
        let (listings, receiver) = tokio::sync::watch::channel(Some(self.listing.clone()));
        let service = self.service.clone();
        (listings, self.run(async move { Some(service.start_automatic(receiver)) }).await.unwrap())
    }

    pub(super) async fn start(&self) -> Value {
        let (service, listing) = (self.service.clone(), self.listing.clone());
        serde_json::to_value(self.run(async move { service.start_update(listing).await }).await).unwrap()
    }

    pub(super) async fn resume(&self) -> Value {
        let (service, listing) = (self.service.clone(), self.listing.clone());
        serde_json::to_value(self.run(async move { service.resume_update(listing).await }).await).unwrap()
    }

    pub(super) async fn pause(&self) -> Value {
        let service = self.service.clone();
        serde_json::to_value(self.run(async move { service.pause_update().await }).await).unwrap()
    }

    pub(super) async fn status(&self) -> Value { serde_json::to_value(self.service.update_status().await).unwrap() }

    pub(super) async fn get(&self, path: &str) -> Value {
        use tower::ServiceExt;
        let response = self.reader.clone().oneshot(axum::http::Request::builder().uri(path).body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    pub(super) async fn snapshot(&self) -> Value { self.get("/api/symbols/005930/financial-source").await }

    pub(super) async fn finished(&self, fake: &Fake) -> Value {
        let mut last = Value::Null;
        let mut requests = 0;
        let mut progressed = tokio::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                let result = self.status().await;
                if result["status"] != "planning" && result["status"] != "collecting" && result["status"] != "pausing" && result["status"] != "checking" { return result; }
                let observed = fake.state.lock().unwrap().calls.len();
                if observed != requests || result != last {
                    requests = observed;
                    last = result.clone();
                    progressed = tokio::time::Instant::now();
                }
                assert!(progressed.elapsed() < Duration::from_secs(60), "financial job made no progress: {result}; {:?}", fake.observed());
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        }).await.unwrap_or_else(|error| panic!("financial job did not finish: {error:?}; last {last}; {:?}", fake.observed()))
    }

    pub(super) async fn settled(&self, fake: &Fake) -> Value {
        self.finished(fake).await;
        self.snapshot().await
    }

    pub(super) async fn crash(self) {
        let service = Arc::downgrade(&self.service);
        drop(self);
        tokio::time::timeout(Duration::from_secs(5), async { while service.strong_count() > 0 { tokio::time::sleep(Duration::from_millis(5)).await; } }).await.expect("the killed collection lets go of the service and its writer lock");
    }
}

impl Drop for Collector {
    fn drop(&mut self) { if let Some(runtime) = self.runtime.take() { runtime.shutdown_background(); } }
}
