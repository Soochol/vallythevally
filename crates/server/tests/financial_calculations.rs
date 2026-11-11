use std::collections::BTreeMap;

use domain::{KstDate, KstTime, TimeOfDay};
use server::api::{FinancialMetric as Metric, FinancialPeriod as Frequency, FinancialPoint, FinancialReason as Reason, FinancialReportingPeriod as Period, FinancialValueStatus as Status, FinancialsPage};
use server::financials::{calculate::page, model::{Account, Basis, Collection, Company, Dividend, FactPeriod, Failure, Fetch, Report, Security, Snapshot, Statement, Verification}};

fn duration(start: &str, end: &str) -> FactPeriod { FactPeriod::Duration { start: start.into(), end: end.into() } }
fn instant(date: &str) -> FactPeriod { FactPeriod::Instant { date: date.into() } }
fn verified(period: FactPeriod) -> Verification { Verification::Verified { period, context_id: "context".into(), source_file: "statement.xbrl".into(), receipt: "20250331000001".into() } }
fn fetch<T>(data: T) -> Fetch<T> { Fetch { data: Some(data), checked_at: Some(100), last_success_at: Some(100), ..Default::default() } }
fn account(id: &str, section: &str, value: f64, current: FactPeriod, cumulative: Option<(f64, FactPeriod)>) -> Account {
    let mut fields: BTreeMap<String,String> = [("account_id", id), ("sj_div", section), ("currency", "KRW"), ("rcept_no", "20250331000001")].into_iter().map(|(k,v)|(k.into(),v.into())).collect();
    fields.insert("thstrm_amount".into(), value.to_string());
    let cumulative_period = match cumulative { Some((v,p)) => { fields.insert("thstrm_add_amount".into(),v.to_string()); verified(p) }, None => Verification::Unverified("amount_missing".into()) };
    Account { fields, current_period: verified(current), cumulative_period }
}
fn report(year: i32, code: &str, start: &str, end: &str, quarter_start: &str, profit: f64, cumulative_profit: f64) -> Report {
    let annual = code == "11011";
    let current = duration(if annual { start } else { quarter_start },end);
    let cumulative = duration(start,end);
    let accounts = vec![
        account("ifrs-full_Revenue","IS",if annual { 1000.0 } else { 100.0 },current.clone(),Some((if annual { 1000.0 } else { 300.0 },cumulative.clone()))),
        account("dart_OperatingIncomeLoss","IS",if annual { -100.0 } else { -10.0 },current.clone(),Some((-30.0,cumulative.clone()))),
        account("ifrs-full_ProfitLossAttributableToOwnersOfParent","IS",profit,current,Some((cumulative_profit,cumulative.clone()))),
        account("ifrs-full_CashFlowsFromUsedInInvestingActivities","CF",if annual { -400.0 } else { -100.0 },cumulative,None),
        account("ifrs-full_Liabilities","BS",200.0,instant(end),None),
        account("ifrs-full_Equity","BS",400.0,instant(end),None),
        account("ifrs-full_EquityAttributableToOwnersOfParent","BS",500.0,instant(end),None),
    ];
    Report { business_year: year, report_code: code.into(), statement: fetch(Statement { basis: Basis::CFS, accounts, source_failure: None }), dividends: Fetch::default() }
}
fn snapshot(reports: Vec<Report>) -> Snapshot {
    let mut collection = Collection { last_checked_at: Some(110), last_attempt_at: Some(90), ..Default::default() };
    collection.disclosures.push([("rcept_no".into(),"20250331000001".into()),("rcept_dt".into(),"20250331".into())].into_iter().collect());
    for r in reports { collection.reports.insert(format!("{}/{}",r.business_year,r.report_code),r); }
    Snapshot { status: "ready", security: Some(Security { stock_code:"005930".into(),company:Company {corp_code:"00126380".into(),name:"합성 회사".into(),fiscal_month:Some(12)},share_class:Some("보통주".into()),share_class_reason:None,evidence:"synthetic".into() }), collection, failure:None,reason:None }
}
fn year() -> Snapshot {
    let previous = report(2023,"11011","2023-01-01","2023-12-31","2023-10-01",80.0,80.0);
    let q1 = report(2024,"11013","2024-01-01","2024-03-31","2024-01-01",10.0,10.0);
    let mut q2 = report(2024,"11012","2024-01-01","2024-06-30","2024-04-01",20.0,30.0);
    q2.statement.data.as_mut().unwrap().accounts[3].fields.insert("thstrm_amount".into(),"-180".into());
    let mut q3 = report(2024,"11014","2024-01-01","2024-09-30","2024-07-01",30.0,60.0);
    q3.statement.data.as_mut().unwrap().accounts[3].fields.insert("thstrm_amount".into(),"-300".into());
    let annual = report(2024,"11011","2024-01-01","2024-12-31","2024-10-01",100.0,100.0);
    snapshot(vec![previous,q1,q2,q3,annual])
}
fn point<'a>(page: &'a FinancialsPage, metric: Metric, year: i32, code: &str) -> &'a FinancialPoint {
    page.series.iter().find(|s|s.metric == metric).unwrap().points.iter().find(|p|p.business_year == year && p.report_code == code).unwrap()
}
fn mutate(snapshot: &mut Snapshot, year: i32, code: &str, edit: impl FnOnce(&mut Statement)) { edit(snapshot.collection.reports.get_mut(&format!("{year}/{code}")).unwrap().statement.data.as_mut().unwrap()); }
fn value(snapshot: Snapshot, metric: Metric, code: &str) -> FinancialPoint { point(&page("005930",Frequency::Q,snapshot),metric,2024,code).clone() }

#[test]
fn calculates_quarter_annual_q4_negative_cash_flow_and_owner_roe() {
    let quarterly = page("005930",Frequency::Q,year());
    assert_eq!(point(&quarterly,Metric::Revenue,2024,"11013").value,Some(100.0));
    assert_eq!(point(&quarterly,Metric::Revenue,2024,"11011").value,Some(700.0));
    assert_eq!(point(&quarterly,Metric::OperatingIncome,2024,"11011").value,Some(-70.0));
    for (code,expected) in [("11013",-100.0),("11012",-80.0),("11014",-120.0),("11011",-100.0)] { assert_eq!(point(&quarterly,Metric::InvestingCashFlow,2024,code).value,Some(expected)); }
    assert_eq!(point(&quarterly,Metric::OwnerRoe,2024,"11011").value,Some(20.0));
    assert_eq!(point(&quarterly,Metric::DebtRatio,2024,"11012").value,Some(50.0));
    let annual = page("005930",Frequency::Y,year());
    assert_eq!(point(&annual,Metric::Revenue,2024,"11011").value,Some(1000.0));
    assert_eq!(point(&annual,Metric::OwnerRoe,2024,"11011").value,Some(20.0));
    assert_eq!(point(&annual,Metric::InvestingCashFlow,2024,"11011").value,Some(-400.0));
}

#[test]
fn roe_requires_contiguous_actual_twelve_months_and_matching_opening_equity() {
    for missing in ["2024/11013","2024/11012","2023/11011"] {
        let mut data=year();data.collection.reports.remove(missing);
        let p=value(data,Metric::OwnerRoe,"11011");assert_eq!(p.value,None);assert_ne!(p.status,Status::Available);
    }
    let mut data=year();
    mutate(&mut data,2024,"11012",|s|s.accounts[2].current_period=verified(duration("2024-03-01","2024-05-31")));
    assert_eq!(value(data,Metric::OwnerRoe,"11011").reason,Some(Reason::MissingComparison));
    let mut data=year();
    mutate(&mut data,2023,"11011",|s|s.accounts[6].current_period=verified(instant("2023-12-30")));
    assert_eq!(value(data,Metric::OwnerRoe,"11011").reason,Some(Reason::MissingComparison));
}

#[test]
fn rolling_roe_crosses_year_boundary_with_exact_endpoints() {
    let mut data=year();
    let mut q1=report(2025,"11013","2025-01-01","2025-03-31","2025-01-01",50.0,50.0);
    q1.statement.data.as_mut().unwrap().accounts[6].fields.insert("thstrm_amount".into(),"700".into());
    data.collection.reports.insert("2025/11013".into(),q1);
    let response=page("005930",Frequency::Q,data);
    let p=point(&response,Metric::OwnerRoe,2025,"11013");
    assert!((p.value.unwrap()-140.0/600.0*100.0).abs()<1e-10);
    assert_eq!(p.period,Some(Period::Duration {start:"2024-04-01".into(),end:"2025-03-31".into()}));
}

#[test]
fn basis_currency_period_and_collection_generation_are_not_mixed() {
    for (expected,change) in [(Reason::BasisChanged,0),(Reason::CurrencyMismatch,1),(Reason::PeriodMismatch,2),(Reason::RefreshIncomplete,3)] {
        let mut data=year();
        match change {
            0=>mutate(&mut data,2024,"11014",|s|s.basis=Basis::OFS),
            1=>mutate(&mut data,2024,"11014",|s|{s.accounts[0].fields.insert("currency".into(),"USD".into());}),
            2=>mutate(&mut data,2024,"11014",|s|s.accounts[0].cumulative_period=verified(duration("2023-12-01","2024-09-30"))),
            _=>data.collection.reports.get_mut("2024/11014").unwrap().statement.refresh_version=1,
        }
        let p=value(data,Metric::Revenue,"11011");assert_eq!(p.value,None);assert_eq!(p.reason,Some(expected));assert_eq!(p.inputs.len(),2);
    }
    let mut data=year();mutate(&mut data,2024,"11012",|s|s.basis=Basis::OFS);
    assert_eq!(value(data,Metric::OwnerRoe,"11011").reason,Some(Reason::BasisChanged));
}

#[test]
fn invalid_or_missing_accounts_do_not_become_zero_or_general_roe() {
    for (expected,change) in [(Reason::PeriodUnverified,0),(Reason::ReceiptMismatch,1),(Reason::AmbiguousAccount,2),(Reason::AmountMissing,3)] {
        let mut data=year();mutate(&mut data,2024,"11013",|s|match change {
            0=>s.accounts[0].current_period=Verification::Unverified("matching_context_missing".into()),
            1=>{s.accounts[0].fields.insert("rcept_no".into(),"20250331000002".into());},
            2=>{let mut other=s.accounts[0].clone();other.fields.insert("thstrm_amount".into(),"200".into());s.accounts.push(other);},
            _=>{s.accounts[0].fields.insert("thstrm_amount".into(),"-".into());},
        });assert_eq!(value(data,Metric::Revenue,"11013").reason,Some(expected));
    }
    let mut data=year();mutate(&mut data,2024,"11011",|s|{s.accounts[2].fields.insert("account_id".into(),"ifrs-full_ProfitLoss".into());});
    assert_eq!(value(data,Metric::OwnerRoe,"11011").status,Status::MissingItem);
    let mut data=year();mutate(&mut data,2024,"11013",|s|{s.accounts[0].fields.insert("account_id".into(),"-표준계정코드 미사용-".into());});
    let p=value(data,Metric::Revenue,"11013");assert_eq!(p.status,Status::MissingItem);assert_eq!(p.reason,Some(Reason::AccountMappingUnverified));assert_eq!(p.inputs[0].amount.as_deref(),Some("100"));
}

#[test]
fn zero_and_negative_denominators_keep_the_original_amounts() {
    for equity in ["0","-50"] {
        let mut data=year();mutate(&mut data,2024,"11011",|s|{s.accounts[5].fields.insert("thstrm_amount".into(),equity.into());});
        let p=value(data,Metric::DebtRatio,"11011");assert_eq!(p.reason,Some(Reason::NonPositiveEquity));assert_eq!(p.inputs[0].amount.as_deref(),Some("200"));assert_eq!(p.inputs[1].amount.as_deref(),Some(equity));
        let mut data=year();for code in [(2023,"11011"),(2024,"11011")] { mutate(&mut data,code.0,code.1,|s|{s.accounts[6].fields.insert("thstrm_amount".into(),equity.into());}); }
        assert_eq!(value(data,Metric::OwnerRoe,"11011").reason,Some(Reason::NonPositiveAverageEquity));
    }
    let mut data=year();mutate(&mut data,2024,"11013",|s|{s.accounts[0].fields.insert("thstrm_amount".into(),"0".into());s.accounts[2].fields.insert("thstrm_amount".into(),"-10".into());});
    assert_eq!(value(data.clone(),Metric::Revenue,"11013").value,Some(0.0));
    assert_eq!(value(data,Metric::OwnerRoe,"11011").value,Some(16.0));
}

#[test]
fn non_december_periods_use_actual_end_date_and_preserve_tooltip_metadata() {
    let mut data=snapshot(vec![report(2024,"11011","2023-04-01","2024-03-31","2024-01-01",100.0,100.0)]);
    data.security.as_mut().unwrap().company.fiscal_month=Some(3);
    let response=page("005930",Frequency::Y,data);
    let p=point(&response,Metric::Revenue,2024,"11011");assert_eq!(p.value,Some(1000.0));
    let expected=KstTime::from_kst_civil(KstDate::new(2024,1,1).unwrap(),TimeOfDay::MIDNIGHT).unix();
    assert_eq!(p.price_bucket.unwrap().0,expected);assert_eq!(p.period,Some(Period::Duration {start:"2023-04-01".into(),end:"2024-03-31".into()}));
    assert_eq!(p.inputs[0].disclosed_at.as_deref(),Some("2025-03-31"));assert_eq!(p.inputs[0].receipt.as_deref(),Some("20250331000001"));assert_eq!(p.inputs[0].source_file.as_deref(),Some("statement.xbrl"));assert_eq!(response.fiscal_month,Some(3));assert!(response.latest_corrections);
}

#[test]
fn shortened_periods_and_price_bucket_collisions_are_not_summed() {
    let data=snapshot(vec![report(2024,"11011","2024-07-01","2024-12-31","2024-10-01",50.0,50.0)]);
    let response=page("005930",Frequency::Y,data);let p=point(&response,Metric::Revenue,2024,"11011");assert_eq!(p.value,None);assert_eq!(p.reason,Some(Reason::ShortPeriod));assert_eq!(p.inputs[0].amount.as_deref(),Some("1000"));
    let data=snapshot(vec![report(2023,"11011","2023-01-01","2023-12-31","2023-10-01",50.0,50.0),report(2024,"11011","2023-04-01","2023-12-31","2023-10-01",50.0,50.0)]);
    let response=page("005930",Frequency::Y,data);
    for p in &response.series[0].points {assert_eq!(p.reason,Some(Reason::PeriodOverlap));assert_eq!(p.value,None);}
    assert_eq!(point(&response,Metric::Revenue,2023,"11011").reported_value,Some(1000.0));
}

fn dividends(class: &str, amount: &str) -> Dividend {
    Dividend {settlement_date:Some("2024-12-31".into()),period_reason:None,fields:[("se","주당 현금배당금(원)"),("thstrm",amount),("rcept_no","20250331000001"),("stock_knd",class)].into_iter().map(|(k,v)|(k.into(),v.into())).collect(),share_class:Some(class.into()),share_class_reason:None}
}

#[test]
fn annual_dps_is_share_class_specific_and_quarterly_dps_is_annual_only() {
    let mut data=year();data.collection.reports.get_mut("2024/11011").unwrap().dividends=fetch(vec![dividends("보통주","0"),dividends("우선주","101")]);
    let p=point(&page("005930",Frequency::Y,data.clone()),Metric::Dps,2024,"11011").clone();assert_eq!(p.value,Some(0.0));
    assert_eq!(value(data.clone(),Metric::Dps,"11011").reason,Some(Reason::AnnualOnly));
    data.security.as_mut().unwrap().share_class=Some("우선주".into());
    assert_eq!(point(&page("005935",Frequency::Y,data.clone()),Metric::Dps,2024,"11011").value,Some(101.0));
    data.security.as_mut().unwrap().share_class_reason=Some("preferred_issue_class_unverified".into());
    assert_eq!(point(&page("005935",Frequency::Y,data.clone()),Metric::Dps,2024,"11011").reason,Some(Reason::ShareClassUnverified));
    data.security.as_mut().unwrap().share_class_reason=None;
    data.collection.reports.get_mut("2024/11011").unwrap().dividends.data.as_mut().unwrap()[1].settlement_date=None;
    assert_eq!(point(&page("005935",Frequency::Y,data),Metric::Dps,2024,"11011").reason,Some(Reason::PeriodMismatch));
}

#[test]
fn first_and_mid_refresh_failures_preserve_independent_values_and_success_metadata() {
    for existing in [false,true] {
        let mut data=year();let fetch=&mut data.collection.reports.get_mut("2024/11011").unwrap().statement;
        if !existing {fetch.data=None;fetch.last_success_at=None;}
        fetch.failure=Some(Failure::Network);fetch.checked_at=Some(200);data.status="partial_failure";
        let response=page("005930",Frequency::Y,data);let p=point(&response,Metric::Revenue,2024,"11011");
        assert_eq!(response.status,"partial_failure");assert_eq!(response.progress.failed,1);
        if existing {assert_eq!(p.value,Some(1000.0));assert_eq!(p.inputs[0].last_success_at.unwrap().0,100);} else {assert_eq!(p.status,Status::Failed);assert_eq!(p.value,None);}
        assert_eq!(p.inputs[0].failure.as_deref(),Some("network"));assert_eq!(point(&response,Metric::Revenue,2023,"11011").value,Some(1000.0));
    }
}

#[test]
fn unpublished_pending_and_missing_item_are_distinct() {
    for (absent,checked,status) in [(true,Some(100),Status::Unpublished),(false,None,Status::Pending)] {
        let mut data=year();data.collection.reports.get_mut("2024/11011").unwrap().statement=Fetch {absent,checked_at:checked,..Default::default()};
        assert_eq!(value(data,Metric::Revenue,"11011").status,status);
    }
    let mut data=year();mutate(&mut data,2024,"11011",|s|s.accounts.retain(|a|a.fields["account_id"]!="ifrs-full_Revenue"));
    assert_eq!(value(data,Metric::Revenue,"11011").status,Status::MissingItem);
}

#[test]
fn cash_flow_requires_matching_cumulative_start_and_exact_comparison_period() {
    for (start,end) in [("2024-02-01","2024-03-31"),("2024-01-01","2024-02-29"),("2023-10-01","2024-03-31")] {
        let mut data=year();mutate(&mut data,2024,"11013",|s|s.accounts[3].current_period=verified(duration(start,end)));
        assert_eq!(value(data,Metric::InvestingCashFlow,"11012").reason,Some(Reason::PeriodMismatch));
    }
    let mut data=year();mutate(&mut data,2024,"11012",|s|s.accounts[3].current_period=verified(duration("2024-04-01","2024-06-30")));
    assert_eq!(value(data,Metric::InvestingCashFlow,"11012").value,Some(-180.0));
    let mut data=year();data.collection.reports.remove("2024/11014");
    assert_eq!(value(data,Metric::Revenue,"11011").reason,Some(Reason::MissingComparison));
}

#[test]
fn four_contiguous_quarters_must_still_cover_exactly_twelve_months() {
    let mut data=year();
    mutate(&mut data,2024,"11013",|s|s.accounts[2].current_period=verified(duration("2024-01-02","2024-03-31")));
    assert_eq!(value(data,Metric::OwnerRoe,"11011").value,None);
    let mut data=year();mutate(&mut data,2024,"11011",|s|{s.accounts[2].fields.insert("thstrm_amount".into(),"-100".into());});
    assert_eq!(value(data,Metric::OwnerRoe,"11011").value,Some(-20.0));
}

#[test]
fn separate_statements_keep_ordinary_values_without_general_roe_fallback() {
    let mut data=year();for r in data.collection.reports.values_mut() {let s=r.statement.data.as_mut().unwrap();s.basis=Basis::OFS;s.accounts.retain(|a|!a.fields["account_id"].contains("AttributableToOwnersOfParent"));}
    let response=page("005930",Frequency::Y,data);
    assert_eq!(point(&response,Metric::Revenue,2024,"11011").value,Some(1000.0));
    assert_eq!(point(&response,Metric::OwnerRoe,2024,"11011").status,Status::MissingItem);
    assert_eq!(point(&response,Metric::DebtRatio,2024,"11011").value,Some(50.0));
}

#[test]
fn unverified_and_nonstandard_facts_cannot_supply_their_own_placement() {
    let mut data=year();mutate(&mut data,2024,"11013",|s|{s.accounts.retain(|a|a.fields["account_id"]=="ifrs-full_Revenue");s.accounts[0].current_period=Verification::Unverified("matching_context_missing".into());s.accounts[0].cumulative_period=Verification::Unverified("amount_missing".into());});
    let p=value(data,Metric::Revenue,"11013");assert_eq!(p.reason,Some(Reason::PeriodUnverified));assert_eq!(p.price_bucket,None);
    assert_eq!(p.inputs[0].verification_reason.as_deref(),Some("matching_context_missing"));
    let mut data=year();mutate(&mut data,2024,"11013",|s|{s.accounts.retain(|a|a.fields["account_id"]=="ifrs-full_Revenue");s.accounts[0].fields.insert("rcept_no".into(),"20250331000002".into());});
    let p=value(data,Metric::Revenue,"11013");assert_eq!(p.reason,Some(Reason::ReceiptMismatch));assert_eq!(p.price_bucket,None);
}

#[test]
fn unmapped_accounts_do_not_anchor_a_reporting_period() {
    let mut data=year();mutate(&mut data,2024,"11013",|s|{s.accounts.retain(|a|a.fields["account_id"]=="ifrs-full_Revenue");s.accounts[0].fields.insert("account_id".into(),"custom_Revenue".into());});
    let p=value(data,Metric::Revenue,"11013");assert_eq!(p.reason,Some(Reason::AccountMappingUnverified));assert_eq!(p.price_bucket,None);
}

#[test]
fn initial_xbrl_failure_is_distinct_from_permanent_unverified_mapping() {
    let mut data=year();mutate(&mut data,2024,"11013",|s|{s.source_failure=Some(Failure::Remote);s.accounts[0].current_period=Verification::Unverified("matching_context_missing".into());});
    let p=value(data,Metric::Revenue,"11013");assert_eq!(p.status,Status::Failed);assert_eq!(p.inputs[0].failure.as_deref(),Some("remote"));
}

#[test]
fn oversized_period_is_not_mislabeled_as_a_shortened_year() {
    let data=snapshot(vec![report(2024,"11011","2023-12-01","2024-12-31","2024-10-01",50.0,50.0)]);
    let response=page("005930",Frequency::Y,data);
    assert_eq!(point(&response,Metric::Revenue,2024,"11011").reason,Some(Reason::PeriodMismatch));
}
