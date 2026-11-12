use std::collections::BTreeMap;

use domain::{KstDate, KstTime, TimeOfDay};
use server::api::{FinancialBasis, FinancialInputStatus as InputStatus, FinancialInputUsage as Usage, FinancialMetric as Metric, FinancialPeriod as Frequency, FinancialPoint, FinancialReason as Reason, FinancialReportingPeriod as Period, FinancialValueStatus as Status, FinancialsPage};
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
    Report { statement_request: None, business_year: year, report_code: code.into(), statement: fetch(Statement { basis: Basis::CFS, accounts, source_failure: None }), dividends: Fetch::default() }
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

fn verify_report_xbrl(mut r: Report) -> Report {
    let member=if r.statement.data.as_ref().unwrap().basis == Basis::CFS { "ConsolidatedMember" } else { "SeparateMember" };
    let mut contexts=String::new();
    let mut facts=String::new();
    for (index,a) in r.statement.data.as_ref().unwrap().accounts.iter().enumerate() {
        for (suffix, verification, role) in [("current",&a.current_period,"thstrm_amount"),("cumulative",&a.cumulative_period,"thstrm_add_amount")] {
            let Verification::Verified {period,..}=verification else {continue};
            let period_xml=match period {FactPeriod::Instant {date}=>format!("<instant>{date}</instant>"),FactPeriod::Duration {start,end}=>format!("<startDate>{start}</startDate><endDate>{end}</endDate>")};
            let context_id=format!("c{index}_{suffix}");
            contexts.push_str(&format!(r#"<context id="{context_id}"><entity><identifier scheme="http://dart.fss.or.kr/ifrs/CIK">00126380</identifier></entity><period>{period_xml}</period><scenario><xbrldi:explicitMember dimension="ifrs-full:ConsolidatedAndSeparateFinancialStatementsAxis">ifrs-full:{member}</xbrldi:explicitMember></scenario></context>"#));
            let concept=a.fields["account_id"].replacen('_',":",1);
            facts.push_str(&format!(r#"<{concept} contextRef="{context_id}" unitRef="{}">{}</{concept}>"#,a.fields["currency"],a.fields[role]));
        }
    }
    let xml=format!(r#"<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:ifrs-full="http://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full" xmlns:dart="http://dart.fss.or.kr/ifrs/2024" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:iso4217="http://www.xbrl.org/2003/iso4217"><unit id="KRW"><measure>iso4217:KRW</measure></unit><unit id="USD"><measure>iso4217:USD</measure></unit>{contexts}{facts}</xbrl>"#);
    let rows=r.statement.data.as_ref().unwrap().accounts.iter().map(|a| {let mut row=a.fields.clone();row.insert("reprt_code".into(),r.report_code.clone());row}).collect();
    let end=match &r.statement.data.as_ref().unwrap().accounts[0].current_period {Verification::Verified {period:FactPeriod::Duration {end,..},..}=>end,Verification::Verified {period:FactPeriod::Instant {date},..}=>date,_=>panic!()};
    let verified=server::financials::xbrl::accounts(rows,r.statement.data.as_ref().unwrap().basis,"00126380","20250331000001",&[("synthetic.xbrl".into(),xml)],Some(&end[..7])).unwrap();
    r.statement.data.as_mut().unwrap().accounts=verified;
    r
}

fn balance_report(capital: &str, income_unverified: bool) -> Report {
    let mut r=report(2024,"11011","2024-07-01","2024-12-31","2024-10-01",100.0,100.0);
    r.statement.data.as_mut().unwrap().accounts.retain(|a|a.fields["sj_div"]=="BS");
    r.statement.data.as_mut().unwrap().accounts[1].fields.insert("thstrm_amount".into(),capital.into());
    if income_unverified {
        let mut income=account("ifrs-full_Revenue","IS",1000.0,duration("2024-01-01","2024-12-31"),None);
        income.current_period=Verification::Unverified("matching_context_missing".into());
        r.statement.data.as_mut().unwrap().accounts.push(income);
    }
    verify_report_xbrl(r)
}

#[test]
fn verified_balance_instants_work_without_income_and_ignore_short_income_duration() {
    for unverified in [false,true] {
        for frequency in [Frequency::Q,Frequency::Y] {
            let r=balance_report("400",unverified);
            assert!(r.statement.data.as_ref().unwrap().accounts.iter().filter(|a|a.fields["sj_div"]=="BS").all(|a|matches!(a.current_period,Verification::Verified {..})));
            let response=page("005930",frequency,snapshot(vec![r]));
            let p=point(&response,Metric::DebtRatio,2024,"11011");
            assert_eq!(p.value,Some(50.0));assert_eq!(p.status,Status::Available);
            assert_eq!(p.period,Some(Period::Instant {date:"2024-12-31".into()}));
            let month=if frequency == Frequency::Q {10} else {1};
            assert_eq!(p.price_bucket.unwrap().0,KstTime::from_kst_civil(KstDate::new(2024,month,1).unwrap(),TimeOfDay::MIDNIGHT).unix());
            assert_eq!(p.inputs.len(),2);
            for (input,amount) in p.inputs.iter().zip(["200","400"]) {
                assert_eq!(input.amount.as_deref(),Some(amount));assert_eq!(input.period,p.period);
                assert_eq!(input.source_file.as_deref(),Some("synthetic.xbrl"));assert!(input.context_id.is_some());
                assert_eq!(input.receipt.as_deref(),Some("20250331000001"));assert_eq!(input.basis,Some(FinancialBasis::CFS));assert_eq!(input.currency.as_deref(),Some("KRW"));
                assert_eq!(input.business_year,2024);assert_eq!(input.report_code,"11011");assert_eq!(input.status,InputStatus::Available);assert_eq!(input.usage,Usage::Value);
                assert_eq!(input.checked_at.unwrap().0,100);assert_eq!(input.last_success_at.unwrap().0,100);
            }
        }
    }
    let r=verify_report_xbrl(report(2024,"11011","2024-07-01","2024-12-31","2024-10-01",50.0,50.0));
    let response=page("005930",Frequency::Y,snapshot(vec![r]));
    assert_eq!(point(&response,Metric::Revenue,2024,"11011").reason,Some(Reason::ShortPeriod));
    assert_eq!(point(&response,Metric::DebtRatio,2024,"11011").value,Some(50.0));
}

#[test]
fn nonpositive_balance_equity_preserves_both_amounts_and_actual_instant() {
    for capital in ["0","-50"] {
        let response=page("005930",Frequency::Y,snapshot(vec![balance_report(capital,false)]));
        let p=point(&response,Metric::DebtRatio,2024,"11011");
        assert_eq!(p.status,Status::NotCalculable);assert_eq!(p.reason,Some(Reason::NonPositiveEquity));assert_eq!(p.value,None);
        assert_eq!(p.period,Some(Period::Instant {date:"2024-12-31".into()}));assert!(p.price_bucket.is_some());
        assert_eq!(p.inputs.len(),2);assert_eq!(p.inputs[0].amount.as_deref(),Some("200"));assert_eq!(p.inputs[1].amount.as_deref(),Some(capital));
        assert!(p.inputs.iter().all(|i|i.period == p.period && i.source_file.as_deref() == Some("synthetic.xbrl")));
    }
}

#[test]
fn balance_inputs_require_matching_instants_currency_and_receipts() {
    for (change,reason) in [(0,Reason::PeriodMismatch),(1,Reason::CurrencyMismatch),(2,Reason::ReceiptMismatch),(3,Reason::PeriodUnverified)] {
        let mut r=balance_report("400",false);
        let equity=&mut r.statement.data.as_mut().unwrap().accounts[1];
        match change {
            0=>{equity.current_period=verified(instant("2024-12-30"));r=verify_report_xbrl(r);},
            1=>{equity.fields.insert("currency".into(),"USD".into());r=verify_report_xbrl(r);},
            2=>{equity.fields.insert("rcept_no".into(),"20250331000002".into());if let Verification::Verified {receipt,..}=&mut equity.current_period {*receipt="20250331000002".into();}},
            _=>equity.current_period=Verification::Unverified("matching_context_missing".into()),
        }
        let response=page("005930",Frequency::Y,snapshot(vec![r]));let p=point(&response,Metric::DebtRatio,2024,"11011");
        assert_eq!(p.status,Status::NotCalculable);assert_eq!(p.reason,Some(reason));assert_eq!(p.value,None);assert_eq!(p.inputs.len(),2);
        assert_eq!(p.inputs[0].amount.as_deref(),Some("200"));assert_eq!(p.inputs[1].amount.as_deref(),Some("400"));
        if change==0 {assert_eq!(p.inputs[1].period,Some(Period::Instant {date:"2024-12-30".into()}));assert_eq!(p.period,None);}
    }
    let mut r=balance_report("400",true);r.statement.data.as_mut().unwrap().basis=Basis::OFS;r=verify_report_xbrl(r);
    let response=page("005930",Frequency::Y,snapshot(vec![r]));let p=point(&response,Metric::DebtRatio,2024,"11011");
    assert_eq!(p.value,Some(50.0));assert_eq!(p.basis,Some(FinancialBasis::OFS));
}

#[test]
fn q4_missing_comparison_preserves_request_identity_state_and_history() {
    for (case,status) in [(0,InputStatus::MissingReport),(1,InputStatus::Unpublished),(2,InputStatus::MissingItem),(3,InputStatus::Failed),(4,InputStatus::Pending),(5,InputStatus::Failed)] {
        let mut data=year();
        match case {
            0=>{data.collection.reports.remove("2024/11014");},
            1=>data.collection.reports.get_mut("2024/11014").unwrap().statement=Fetch {absent:true,checked_at:Some(200),last_success_at:Some(100),refresh_version:7,..Default::default()},
            2=>{let r=data.collection.reports.get_mut("2024/11014").unwrap();r.statement.checked_at=Some(200);r.statement.data.as_mut().unwrap().accounts.retain(|a|a.fields["account_id"]!="ifrs-full_Revenue");},
            3=>data.collection.reports.get_mut("2024/11014").unwrap().statement=Fetch {failure:Some(Failure::Network),checked_at:Some(200),last_success_at:Some(100),refresh_version:7,..Default::default()},
            4=>data.collection.reports.get_mut("2024/11014").unwrap().statement=Fetch::default(),
            _=>{let r=data.collection.reports.get_mut("2024/11014").unwrap();r.statement.checked_at=Some(200);let statement=r.statement.data.as_mut().unwrap();statement.source_failure=Some(Failure::Remote);statement.accounts[0].cumulative_period=Verification::Unverified("matching_context_missing".into());},
        }
        if case==3 || case==5 {data.status="partial_failure";}
        let response=page("005930",Frequency::Q,data);
        let p=point(&response,Metric::Revenue,2024,"11011");
        assert_eq!(p.status,Status::NotCalculable);assert_eq!(p.reason,Some(Reason::MissingComparison));assert_eq!(p.value,None);
        assert_eq!(p.inputs[0].amount.as_deref(),Some("1000"));assert_eq!(p.inputs[0].usage,Usage::Value);assert_eq!(p.inputs[0].report_code,"11011");
        let comparison=p.inputs.iter().find(|i|i.usage==Usage::Comparison).unwrap();
        assert_eq!(comparison.business_year,2024);assert_eq!(comparison.report_code,"11014");assert_eq!(comparison.status,status);
        assert_eq!(comparison.checked_at.map(|t|t.0),if case==0 || case==4 {None} else {Some(200)});
        assert_eq!(comparison.last_success_at.map(|t|t.0),if case==0 || case==4 {None} else {Some(100)});
        assert_eq!(comparison.failure.as_deref(),if case==3 {Some("network")} else if case==5 {Some("remote")} else {None});
        if case==5 {assert_eq!(comparison.reason,Some(Reason::PeriodUnverified));assert_eq!(comparison.amount.as_deref(),Some("300"));assert_eq!(comparison.verification_reason.as_deref(),Some("matching_context_missing"));}
        assert_eq!(comparison.refresh_version,if case==1 || case==3 {7} else {0});
        assert_eq!(point(&response,Metric::DebtRatio,2024,"11011").value,Some(50.0));
        assert_eq!(point(&response,Metric::Revenue,2024,"11013").value,Some(100.0));
    }
}

#[test]
fn comparison_failure_with_stored_values_keeps_q4_and_dependency_warning() {
    let mut data=year();let fetch=&mut data.collection.reports.get_mut("2024/11014").unwrap().statement;
    fetch.failure=Some(Failure::Network);fetch.checked_at=Some(200);data.status="partial_failure";
    let p=value(data,Metric::Revenue,"11011");assert_eq!(p.value,Some(700.0));assert_eq!(p.status,Status::Available);
    let comparison=p.inputs.iter().find(|i|i.usage==Usage::Comparison).unwrap();
    assert_eq!(comparison.status,InputStatus::Available);assert_eq!(comparison.failure.as_deref(),Some("network"));
    assert_eq!(comparison.checked_at.unwrap().0,200);assert_eq!(comparison.last_success_at.unwrap().0,100);
    assert_eq!(comparison.amount.as_deref(),Some("300"));assert_eq!(comparison.period,Some(Period::Duration {start:"2024-01-01".into(),end:"2024-09-30".into()}));
    let mut data=year();data.collection.reports.get_mut("2024/11011").unwrap().statement=Fetch {absent:true,checked_at:Some(200),last_success_at:Some(200),..Default::default()};
    let p=value(data,Metric::Revenue,"11011");assert_eq!(p.status,Status::Unpublished);assert_eq!(p.reason,None);
    assert_eq!(p.inputs[0].status,InputStatus::Unpublished);assert_eq!(p.inputs[0].report_code,"11011");assert_eq!(p.inputs[0].usage,Usage::Value);
}

#[test]
fn dps_preserves_verified_reporting_period_source_and_refresh_failure() {
    let mut r=verify_report_xbrl(report(2024,"11011","2024-01-01","2024-12-31","2024-10-01",100.0,100.0));
    r.dividends=fetch(vec![dividends("보통주","100")]);r.statement.failure=Some(Failure::Network);r.statement.checked_at=Some(200);
    let mut data=snapshot(vec![r]);data.status="partial_failure";
    let response=page("005930",Frequency::Y,data);let p=point(&response,Metric::Dps,2024,"11011");
    assert_eq!(p.value,Some(100.0));assert_eq!(p.status,Status::Available);assert_eq!(p.basis,Some(FinancialBasis::CFS));
    let anchor=p.inputs.iter().find(|i|i.usage==Usage::ReportingPeriod).unwrap();
    assert_eq!(anchor.period,p.period);assert_eq!(anchor.status,InputStatus::Available);assert_eq!(anchor.basis,p.basis);
    assert_eq!(anchor.failure.as_deref(),Some("network"));assert_eq!(anchor.checked_at.unwrap().0,200);assert_eq!(anchor.last_success_at.unwrap().0,100);
    assert_eq!(anchor.receipt.as_deref(),Some("20250331000001"));assert_eq!(anchor.source_file.as_deref(),Some("synthetic.xbrl"));assert!(anchor.context_id.is_some());
    assert_eq!(anchor.disclosed_at.as_deref(),Some("2025-03-31"));assert_eq!(anchor.business_year,2024);assert_eq!(anchor.report_code,"11011");
    let dividend=p.inputs.iter().find(|i|i.role=="thstrm").unwrap();assert_eq!(dividend.amount.as_deref(),Some("100"));assert_eq!(dividend.failure,None);assert_eq!(dividend.checked_at.unwrap().0,100);
}

#[test]
fn invalid_comparison_keeps_receipt_failure_and_current_annual_evidence() {
    let mut data=year();mutate(&mut data,2024,"11014",|s|{s.accounts[0].fields.insert("rcept_no".into(),"20250331000002".into());});
    let p=value(data,Metric::Revenue,"11011");assert_eq!(p.status,Status::NotCalculable);assert_eq!(p.reason,Some(Reason::MissingComparison));
    assert_eq!(p.inputs[0].amount.as_deref(),Some("1000"));
    let comparison=p.inputs.iter().find(|i|i.usage==Usage::Comparison).unwrap();
    assert_eq!(comparison.status,InputStatus::NotCalculable);assert_eq!(comparison.reason,Some(Reason::ReceiptMismatch));
    assert_eq!(comparison.receipt.as_deref(),Some("20250331000002"));assert_eq!(comparison.amount.as_deref(),Some("300"));
}

#[test]
fn missing_comparison_item_keeps_initial_xbrl_failure_and_fetch_failure_priority() {
    for fetch_failure in [None,Some(Failure::Network)] {
        let mut data=year();data.status="partial_failure";
        let report=data.collection.reports.get_mut("2024/11014").unwrap();
        let mut statement=report.statement.data.take().unwrap();
        statement.accounts.retain(|a|a.fields["account_id"]!="ifrs-full_Revenue");
        statement.source_failure=Some(Failure::Remote);
        let rows=statement.accounts.iter().map(|a|a.fields.clone()).collect();
        statement.accounts=server::financials::xbrl::accounts(rows,Basis::CFS,"00126380","20250331000001",&[],Some("2024-09")).unwrap();
        assert!(statement.accounts.iter().all(|a|matches!(a.current_period,Verification::Unverified(_))));
        report.statement=Fetch::default();report.statement.apply(Ok(Some(statement)),200,0);
        report.statement.failure=fetch_failure;
        if fetch_failure.is_some() {report.statement.checked_at=Some(210);}
        let response=page("005930",Frequency::Q,data);
        assert_eq!(response.status,"partial_failure");assert!(response.progress.failed>0);
        let p=point(&response,Metric::Revenue,2024,"11011");
        assert_eq!(p.status,Status::NotCalculable);assert_eq!(p.reason,Some(Reason::MissingComparison));assert_eq!(p.value,None);
        let prior=p.inputs.iter().find(|i|i.usage==Usage::Comparison).unwrap();
        assert_eq!(prior.status,InputStatus::MissingItem);assert_eq!(prior.business_year,2024);assert_eq!(prior.report_code,"11014");assert_eq!(prior.role,"statement");
        assert_eq!(prior.failure.as_deref(),Some(if fetch_failure.is_some() {"network"} else {"remote"}));
        assert_eq!(prior.checked_at.unwrap().0,if fetch_failure.is_some() {210} else {200});assert_eq!(prior.last_success_at.unwrap().0,200);assert_eq!(prior.refresh_version,0);
        let current=&p.inputs[0];assert_eq!(current.usage,Usage::Value);assert_eq!(current.status,InputStatus::Available);
        assert_eq!(current.amount.as_deref(),Some("1000"));assert_eq!(current.failure,None);
        assert_eq!(current.period,Some(Period::Duration {start:"2024-01-01".into(),end:"2024-12-31".into()}));
        assert_eq!(point(&response,Metric::DebtRatio,2024,"11011").value,Some(50.0));
    }
}
