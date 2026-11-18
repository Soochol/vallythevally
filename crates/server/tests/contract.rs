//! 브라우저 계약(backend.md §10): ts-rs가 지금 만드는 TypeScript가 커밋된 `web/src/api/generated/`와 같아야 한다.
//!
//! `cargo test`는 lib 테스트에서 `#[ts(export)]`로 작업 트리의 파일을 다시 쓴다. 그래서 작업 트리가 아니라
//! 커밋(HEAD)과 비교한다. api.rs를 바꿨으면 생성 파일도 함께 커밋해야 이 테스트가 통과한다.

use std::path::Path;
use std::process::Command;

use indicators::{LineId, MaMethod, Spec as IndicatorSpec};
use server::api::*;
use server::collector::wire::{CollectorAlert, CollectorCoverage, CollectorCoverageDay, CollectorDayBytes, CollectorDayState, CollectorDisk, CollectorDiskUsage, CollectorFilesystem, CollectorKey, CollectorKeyRole, CollectorKeyState, CollectorObservationDay, CollectorPhase, CollectorRenamedStock, CollectorRest, CollectorStatus, CollectorStock, CollectorToday, CollectorUniverseChanges, CollectorVerdict};
use server::collector::{CollectorAccess, CollectorAccessState, CollectorStatusPage, DaemonJudgment};
use server::drawing_api::*;
use ts_rs::TS;

const DIR: &str = "web/src/api/generated";

fn repo_root() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn git(args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(repo_root()).args(args).output().expect("git을 실행할 수 없습니다");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

fn generated<T: TS + 'static>() -> (String, String) {
    let file = T::output_path().expect("export 대상 타입").display().to_string();
    (file, T::export_to_string().unwrap())
}

#[test]
fn generated_typescript_matches_the_committed_files() {
    let ours = [
        generated::<setup::Bundle>(),
        generated::<setup::Document>(),
        generated::<setup::DocumentKind>(),
        generated::<AccountConfirm>(),
        generated::<InitialSyncChoice>(),
        generated::<InitialSyncRequest>(),
        generated::<OrderCancelBatchInput>(),
        generated::<OrderCancelInput>(),
        generated::<OrderCommand>(),
        generated::<OrderCommandKind>(),
        generated::<OrderCommandState>(),
        generated::<OrderCommands>(),
        generated::<OrderModifyInput>(),
        generated::<OrderPlaceInput>(),
        generated::<OrderReconciliation>(),
        generated::<OrderRejectReason>(),
        generated::<OrderSide>(),
        generated::<OrdersAccountCheck>(),
        generated::<OrdersState>(),
        generated::<OrdersStatus>(),
        generated::<OrdersSwitchInput>(),
        generated::<SyncState>(),
        generated::<SyncStatus>(),
        generated::<AccountLoginRequest>(),
        generated::<AccountLoginStart>(),
        generated::<AccountProvider>(),
        generated::<AccountStatus>(),
        generated::<ApiError>(),
        generated::<ApiErrorBody>(),
        generated::<ApiErrorCode>(),
        generated::<ApiErrorReason>(),
        generated::<CollectorAccess>(),
        generated::<CollectorAccessState>(),
        generated::<CollectorAlert>(),
        generated::<CollectorCoverage>(),
        generated::<CollectorCoverageDay>(),
        generated::<CollectorDayBytes>(),
        generated::<CollectorDayState>(),
        generated::<CollectorDisk>(),
        generated::<CollectorDiskUsage>(),
        generated::<CollectorFilesystem>(),
        generated::<CollectorKey>(),
        generated::<CollectorKeyRole>(),
        generated::<CollectorKeyState>(),
        generated::<CollectorObservationDay>(),
        generated::<CollectorPhase>(),
        generated::<CollectorRenamedStock>(),
        generated::<CollectorRest>(),
        generated::<CollectorStatus>(),
        generated::<CollectorStatusPage>(),
        generated::<CollectorStock>(),
        generated::<CollectorToday>(),
        generated::<CollectorUniverseChanges>(),
        generated::<CollectorVerdict>(),
        generated::<DaemonJudgment>(),
        generated::<Bar>(),
        generated::<BarField>(),
        generated::<RecentBars>(),
        generated::<BarsPage>(),
        generated::<BollingerBand>(),
        generated::<BollingerTest>(),
        generated::<Bound>(),
        generated::<Condition>(),
        generated::<DayHistory<ForeignHoldingDay>>(),
        generated::<Direction>(),
        generated::<Drawing>(),
        generated::<DrawingInput>(),
        generated::<DrawingPoint>(),
        generated::<DrawingScope>(),
        generated::<DrawingTool>(),
        generated::<ClientMessage>(),
        generated::<ConnectionStatus>(),
        generated::<ExcludeKind>(),
        generated::<Extreme>(),
        generated::<FinancialBasis>(),
        generated::<FinancialInput>(),
        generated::<FinancialInputStatus>(),
        generated::<FinancialInputUsage>(),
        generated::<FinancialMetric>(),
        generated::<FinancialPeriod>(),
        generated::<FinancialPoint>(),
        generated::<FinancialProgress>(),
        generated::<FinancialReason>(),
        generated::<FinancialReportingPeriod>(),
        generated::<FinancialSeries>(),
        generated::<FinancialUpdateFailure>(),
        generated::<FinancialUpdatePage>(),
        generated::<FinancialUpdatePhase>(),
        generated::<FinancialUpdateStatus>(),
        generated::<FinancialUpdateStopReason>(),
        generated::<FinancialValueStatus>(),
        generated::<FinancialsPage>(),
        generated::<ForeignHoldingDay>(),
        generated::<FullHistory>(),
        generated::<Fundamentals>(),
        generated::<OrderBook>(),
        generated::<OrderBookLevel>(),
        generated::<ProgramTradePoint>(),
        generated::<ProgramTradeTimeline>(),
        generated::<TradePrint>(),
        generated::<TradeTape>(),
        generated::<IchimokuTest>(),
        generated::<IndicatorSpec>(),
        generated::<KeySource>(),
        generated::<KiwoomAtStart>(),
        generated::<KiwoomConnectInput>(),
        generated::<KiwoomConnectStep>(),
        generated::<KiwoomKeyInput>(),
        generated::<PublicIpCheck>(),
        generated::<RegisteredIp>(),
        generated::<RegisteredIpInput>(),
        generated::<KiwoomLinkProblem>(),
        generated::<KiwoomLinkState>(),
        generated::<KiwoomLinkStatus>(),
        generated::<KiwoomTarget>(),
        generated::<KiwoomTargetKind>(),
        generated::<InvestorNetSharesDay>(),
        generated::<KstDate>(),
        generated::<Layout>(),
        generated::<LayoutInput>(),
        generated::<LayoutSummary>(),
        generated::<LayoutSync>(),
        generated::<LayoutWindow>(),
        generated::<LinkColor>(),
        generated::<TradingBalance>(),
        generated::<TradingExecution>(),
        generated::<TradingExecutions>(),
        generated::<TradingHolding>(),
        generated::<TradingOpenOrder>(),
        generated::<TradingOpenOrders>(),
        generated::<TradingOrderable>(),
        generated::<WindowContent>(),
        generated::<WindowId>(),
        generated::<LineId>(),
        generated::<MacdTest>(),
        generated::<MaMethod>(),
        generated::<MaOrder>(),
        generated::<Market>(),
        generated::<Period>(),
        generated::<PriceField>(),
        generated::<Quote>(),
        generated::<Revision>(),
        generated::<QuoteSource>(),
        generated::<RangeCoverage>(),
        generated::<RealtimeState>(),
        generated::<ReloadReason>(),
        generated::<RsiTest>(),
        generated::<Screen>(),
        generated::<ScreenPeriod>(),
        generated::<ScreenerExcluded>(),
        generated::<ScreenerResult>(),
        generated::<ScreenerRow>(),
        generated::<ScreenerStatus>(),
        generated::<ScreenerUpdate>(),
        generated::<ScreenerUpdateRequest>(),
        generated::<Screens>(),
        generated::<ServerMessage>(),
        generated::<Side>(),
        generated::<SkippedDay>(),
        generated::<StochasticTest>(),
        generated::<SubErrorCode>(),
        generated::<FeedKind>(),
        generated::<FeedTrade>(),
        generated::<FeedBookLevel>(),
        generated::<FeedExpected>(),
        generated::<FeedBook>(),
        generated::<FeedProgramRow>(),
        generated::<FeedBroker>(),
        generated::<FeedBrokers>(),
        generated::<SurgeField>(),
        generated::<SymbolCode>(),
        generated::<SymbolInfo>(),
        generated::<SymbolKind>(),
        generated::<SystemSettings>(),
        generated::<UiState>(),
        generated::<UndatedRow>(),
        generated::<UnixSeconds>(),
        generated::<UpdatePhase>(),
        generated::<Venue>(),
        generated::<WatchGroup>(),
        generated::<Watchlist>(),
        generated::<Watchlists>(),
    ];
    let mut committed: Vec<String> = git(&["ls-tree", "--name-only", "HEAD", &format!("{DIR}/")])
        .lines()
        .map(|l| l.trim_start_matches(&format!("{DIR}/")).to_owned())
        .collect();
    committed.sort();
    let mut names: Vec<String> = ours.iter().map(|(f, _)| f.clone()).collect();
    names.sort();
    assert_eq!(names, committed, "생성 파일 목록이 커밋과 다릅니다");
    for (file, text) in ours {
        let head = git(&["show", &format!("HEAD:{DIR}/{file}")]);
        assert_eq!(text, head, "{file}가 커밋된 것과 다릅니다. cargo test로 다시 만들고 함께 커밋하세요");
    }
}
