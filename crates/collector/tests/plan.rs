use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use collector::collect::config::Variables;
use collector::keys::{KeyIdentity, KeyList, KeyRole, KeysError};
use collector::kst::KstTime;
use collector::plan::{
    KEY_CAPACITY, KeyShare, MARKET_TYPES, PlanError, PlanFile, PlanInput, Violation, build_plan, check_plan, plan_path, read_plan, write_plan,
};
use collector::protocol::KeyName;
use collector::universe::{Diff, Entry, MarketName, StockKind, UniverseFile};
use serde_json::json;
use server::kiwoom::token_file::credential_id;

const DATE: u32 = 20261118;

fn identity(name: &str, role: KeyRole) -> KeyIdentity {
    KeyIdentity { name: KeyName::parse(name).unwrap(), role, app_key_hash: credential_id(&format!("FAKE-APPKEY-{name}")) }
}

fn identities(collecting: usize) -> Vec<KeyIdentity> {
    let mut keys: Vec<KeyIdentity> = (1..=collecting).map(|number| identity(&format!("collect-{number:02}"), KeyRole::Collecting)).collect();
    keys.push(identity("spare-01", KeyRole::Spare));
    keys
}

fn entry(code: &str, registered: bool) -> Entry {
    Entry { code: code.to_owned(), name: format!("종목{code}"), market: MarketName::Kospi, kind: StockKind::Common, status: Vec::new(), registered }
}

fn code(number: usize) -> String {
    format!("{:06}", number + 1)
}

fn universe(stocks: Vec<Entry>) -> UniverseFile {
    UniverseFile { format_version: 1, date: DATE, fetched_at: "2026-11-18T07:20:00+09:00".to_owned(), stocks, warnings: Vec::new(), diff: Diff::default(), replaced: None }
}

fn universe_of(count: usize) -> UniverseFile {
    universe((0..count).map(|number| entry(&code(number), true)).collect())
}

fn uneven_messages(count: usize) -> BTreeMap<String, u64> {
    (0..count).map(|number| (code(number), ((number * 7919) % 1000 + 1) as u64 * if number % 13 == 0 { 40 } else { 1 })).collect()
}

fn plan(keys: &[KeyIdentity], universe: &UniverseFile, messages: &BTreeMap<String, u64>) -> PlanFile {
    plan_by(keys, universe, messages, None)
}

fn plan_by(keys: &[KeyIdentity], universe: &UniverseFile, messages: &BTreeMap<String, u64>, turnover: Option<&BTreeMap<String, u64>>) -> PlanFile {
    build_plan(&PlanInput { date: DATE, created_at: KstTime { date: DATE, ms_of_day: 7 * 3_600_000 + 35 * 60_000 }, keys, universe, previous_messages: messages, turnover }).unwrap()
}

fn stocks_on(plan: &PlanFile) -> Vec<&String> {
    plan.keys.iter().flat_map(|key| &key.stocks).collect()
}

#[test]
fn every_registrable_stock_lands_on_exactly_one_key_and_the_spare_stays_empty() {
    let universe = universe_of(2600);
    let plan = plan(&identities(14), &universe, &uneven_messages(2600));
    let mut placed = stocks_on(&plan);
    placed.sort();
    let expected: Vec<String> = (0..2600).map(code).collect();
    assert_eq!(placed.into_iter().cloned().collect::<Vec<_>>(), expected);
    for key in &plan.keys {
        assert!(key.stocks.len() <= KEY_CAPACITY, "{}: {}", key.name, key.stocks.len());
        if key.role == KeyRole::Spare {
            assert!(key.stocks.is_empty() && key.market_types.is_empty() && key.rest_jobs.is_empty());
        }
    }
    assert!(plan.excluded.is_empty() && plan.alerts.is_empty());
    assert_eq!(plan.input.active_keys, 15);
    assert_eq!(check_plan(&plan), Ok(()));
}

#[test]
fn loads_are_spread_within_one_stock_when_capacity_is_not_reached() {
    let universe = universe_of(1000);
    let messages = uneven_messages(1000);
    let plan = plan(&identities(14), &universe, &messages);
    let collecting_loads: Vec<u64> = plan.keys.iter().filter(|key| key.role == KeyRole::Collecting).map(|key| key.load).collect();
    let spread = collecting_loads.iter().max().unwrap() - collecting_loads.iter().min().unwrap();
    let heaviest_stock = messages.values().max().unwrap();
    assert!(spread <= *heaviest_stock, "spread {spread} > heaviest {heaviest_stock}");
    for key in plan.keys.iter().filter(|key| key.role == KeyRole::Collecting) {
        let summed: u64 = key.stocks.iter().map(|stock| messages[stock]).sum();
        assert_eq!(key.load, summed);
    }
}

#[test]
fn the_same_input_gives_the_same_plan_in_any_order() {
    let universe = universe_of(700);
    let messages = uneven_messages(700);
    let keys = identities(5);
    let first = plan(&keys, &universe, &messages);
    assert_eq!(plan(&keys, &universe, &messages), first);
    let mut shuffled_keys = keys.clone();
    shuffled_keys.reverse();
    let mut shuffled = universe.clone();
    shuffled.stocks.reverse();
    shuffled.stocks.rotate_left(123);
    assert_eq!(plan(&shuffled_keys, &shuffled, &messages), first);
}

#[test]
fn stocks_beyond_the_capacity_are_excluded_by_code_order_with_an_alert() {
    let universe = universe_of(600);
    let plan = plan(&identities(3), &universe, &uneven_messages(600));
    assert_eq!(stocks_on(&plan).len(), 570);
    let expected: Vec<String> = (570..600).map(code).collect();
    assert_eq!(plan.excluded, expected);
    assert!(stocks_on(&plan).iter().all(|placed| !plan.excluded.contains(placed)));
    assert_eq!(plan.alerts.len(), 1, "{:?}", plan.alerts);
    assert!(plan.alerts[0].contains("30개") && plan.alerts[0].contains("000571~000600"), "{}", plan.alerts[0]);
    assert_eq!(check_plan(&plan), Ok(()));
}

#[test]
fn stocks_beyond_the_capacity_are_picked_by_turnover() {
    let universe = universe_of(600);
    let unknown = [100, 200, 300, 400, 500];
    let turnover: BTreeMap<String, u64> = (0..600).filter(|number| !unknown.contains(number)).map(|number| (code(number), number as u64 + 1)).collect();
    let first = plan_by(&identities(3), &universe, &uneven_messages(600), Some(&turnover));
    let expected: Vec<String> = (0..25).chain(unknown).map(code).collect();
    assert_eq!(first.excluded, expected);
    assert_eq!(stocks_on(&first).len(), 570);
    assert!(stocks_on(&first).contains(&&code(599)));
    assert_eq!(first.alerts.len(), 1, "{:?}", first.alerts);
    assert!(first.alerts[0].contains("30개") && first.alerts[0].contains("거래대금") && !first.alerts[0].contains('~'), "{}", first.alerts[0]);
    assert_eq!(check_plan(&first), Ok(()));

    let mut shuffled = universe.clone();
    shuffled.stocks.reverse();
    shuffled.stocks.rotate_left(77);
    assert_eq!(plan_by(&identities(3), &shuffled, &uneven_messages(600), Some(&turnover)), first);

    let flat: BTreeMap<String, u64> = (0..600).map(|number| (code(number), 7)).collect();
    let tied = plan_by(&identities(3), &universe, &uneven_messages(600), Some(&flat));
    assert_eq!(tied.excluded, (570..600).map(code).collect::<Vec<_>>());
}

#[test]
fn a_plan_without_turnover_falls_back_to_code_order_and_says_so() {
    let short = plan(&identities(3), &universe_of(600), &uneven_messages(600));
    assert_eq!(short.excluded, (570..600).map(code).collect::<Vec<_>>());
    assert_eq!(short.alerts.len(), 1, "{:?}", short.alerts);
    assert!(short.alerts[0].contains("종목코드 순서") && short.alerts[0].contains("000571~000600"), "{}", short.alerts[0]);
    let roomy = plan(&identities(3), &universe_of(570), &uneven_messages(570));
    assert!(roomy.excluded.is_empty() && roomy.alerts.is_empty());
}

#[test]
fn a_new_stock_without_yesterdays_count_goes_to_the_key_with_fewer_stocks() {
    let keys = vec![identity("collect-01", KeyRole::Collecting), identity("collect-02", KeyRole::Collecting), identity("spare-01", KeyRole::Spare)];
    let universe = universe(vec![entry("000001", true), entry("000002", true), entry("000003", true), entry("000004", true)]);
    let messages = BTreeMap::from([("000001".to_owned(), 50), ("000002".to_owned(), 10), ("000003".to_owned(), 10)]);
    let plan = plan(&keys, &universe, &messages);
    let share = |name: &str| plan.keys.iter().find(|key| key.name.as_str() == name).unwrap();
    assert_eq!(share("collect-01").stocks, ["000001", "000004"]);
    assert_eq!(share("collect-02").stocks, ["000002", "000003"]);
}

#[test]
fn halted_stocks_are_listed_but_not_registered_and_market_types_sit_on_one_collecting_key() {
    let mut stocks: Vec<Entry> = (0..300).map(|number| entry(&code(number), true)).collect();
    stocks.push(entry("999990", false));
    stocks.push(entry("999991", false));
    let plan = plan(&identities(2), &universe(stocks), &BTreeMap::new());
    assert_eq!(plan.unregistered, ["999990", "999991"]);
    assert!(stocks_on(&plan).iter().all(|placed| !plan.unregistered.contains(placed)));
    let holders: Vec<_> = plan.keys.iter().filter(|key| !key.market_types.is_empty()).collect();
    assert_eq!(holders.len(), 1);
    assert_eq!(holders[0].role, KeyRole::Collecting);
    assert_eq!(holders[0].market_types, MARKET_TYPES);
}

#[test]
fn a_plan_without_a_collecting_key_is_refused() {
    let keys = vec![identity("spare-01", KeyRole::Spare)];
    let result = build_plan(&PlanInput {
        date: DATE,
        created_at: KstTime { date: DATE, ms_of_day: 0 },
        keys: &keys,
        universe: &universe_of(3),
        previous_messages: &BTreeMap::new(),
        turnover: None,
    });
    assert!(matches!(result, Err(PlanError::NoCollectingKey)));
}

#[test]
fn the_check_rejects_a_stock_on_two_keys_and_nothing_is_written() {
    let mut plan = plan(&identities(2), &universe_of(10), &BTreeMap::new());
    let moved = plan.keys[1].stocks[0].clone();
    plan.keys[0].stocks.push(moved.clone());
    assert!(matches!(check_plan(&plan), Err(Violation::StockOnTwoKeys { code, .. }) if code == moved));
    let data = tempfile::tempdir().unwrap();
    assert!(matches!(write_plan(data.path(), &plan), Err(PlanError::Violation(_))));
    assert!(!plan_path(data.path(), DATE).exists());
}

#[test]
fn the_check_rejects_work_on_the_spare_and_a_market_type_on_two_keys() {
    let mut spare_work = plan(&identities(2), &universe_of(10), &BTreeMap::new());
    spare_work.keys.last_mut().unwrap().rest_jobs.push("ka10081".to_owned());
    assert!(matches!(check_plan(&spare_work), Err(Violation::SpareHoldsWork(_))));
    let mut doubled = plan(&identities(2), &universe_of(10), &BTreeMap::new());
    let other = doubled.keys.iter_mut().find(|key| key.market_types.is_empty() && key.role == KeyRole::Collecting).unwrap();
    other.market_types.push(MARKET_TYPES[0]);
    assert!(matches!(check_plan(&doubled), Err(Violation::MarketTypeCount { market_type: "0J", keys: 2 })));
}

#[test]
fn an_existing_plan_file_is_never_overwritten() {
    let data = tempfile::tempdir().unwrap();
    let first = plan(&identities(2), &universe_of(10), &BTreeMap::new());
    write_plan(data.path(), &first).unwrap();
    assert_eq!(read_plan(data.path(), DATE).unwrap(), first);
    let bytes = fs::read(plan_path(data.path(), DATE)).unwrap();
    let second = plan(&identities(2), &universe_of(20), &BTreeMap::new());
    assert!(matches!(write_plan(data.path(), &second), Err(PlanError::AlreadyExists { .. })));
    assert_eq!(fs::read(plan_path(data.path(), DATE)).unwrap(), bytes);
    let names: Vec<_> = fs::read_dir(plan_path(data.path(), DATE).parent().unwrap()).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(names, [format!("{DATE}.json")], "임시 파일이 남지 않는다");
}

struct KeyFiles {
    folder: tempfile::TempDir,
}

struct KeySpec<'a> {
    name: &'a str,
    app_key: &'a str,
    app_secret: &'a str,
    hash_of: &'a str,
    spare: bool,
    mode: u32,
}

impl<'a> KeySpec<'a> {
    fn new(name: &'a str, app_key: &'a str) -> KeySpec<'a> {
        KeySpec { name, app_key, app_secret: "FAKE-SECRET-VALUE-7777", hash_of: app_key, spare: false, mode: 0o600 }
    }
}

impl KeyFiles {
    fn new() -> KeyFiles {
        KeyFiles { folder: tempfile::tempdir().unwrap() }
    }

    fn secret_path(&self, name: &str) -> PathBuf {
        self.folder.path().join(format!("{name}.env"))
    }

    fn entry(&self, spec: &KeySpec) -> serde_json::Value {
        let path = self.secret_path(spec.name);
        fs::write(&path, format!("VALLY_COLLECTOR_APP_KEY={}\nVALLY_COLLECTOR_APP_SECRET={}\n", spec.app_key, spec.app_secret)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(spec.mode)).unwrap();
        json!({"name": spec.name, "active": true, "spare": spec.spare, "app_key_hash": credential_id(spec.hash_of), "secret_file": path})
    }

    fn load(&self, entries: Vec<serde_json::Value>, process: &Variables) -> Result<KeyList, KeysError> {
        let path = self.folder.path().join("keys.json");
        fs::write(&path, json!({"version": 1, "keys": entries}).to_string()).unwrap();
        KeyList::load(&path, Path::new("/state/collector"), process)
    }
}

fn good_entries(files: &KeyFiles) -> Vec<serde_json::Value> {
    vec![
        files.entry(&KeySpec::new("collect-01", "FAKE-APPKEY-AAAA")),
        files.entry(&KeySpec::new("collect-02", "FAKE-APPKEY-BBBB")),
        files.entry(&KeySpec { spare: true, ..KeySpec::new("spare-01", "FAKE-APPKEY-CCCC") }),
    ]
}

fn assert_no_secret(error: &KeysError) {
    let message = error.to_string();
    for secret in ["FAKE-APPKEY-AAAA", "FAKE-APPKEY-BBBB", "FAKE-APPKEY-CCCC", "FAKE-SECRET-VALUE-7777"] {
        assert!(!message.contains(secret), "{message}");
    }
}

#[test]
fn a_valid_key_list_loads_with_default_paths_under_the_state_folder() {
    let files = KeyFiles::new();
    let mut entries = good_entries(&files);
    entries.push(json!({"name": "later-01", "active": false, "spare": false, "app_key_hash": credential_id("FAKE-APPKEY-DDDD"), "secret_file": "/not/yet/there.env"}));
    let list = files.load(entries, &Variables::new()).unwrap();
    let names: Vec<&str> = list.active.iter().map(|key| key.identity.name.as_str()).collect();
    assert_eq!(names, ["collect-01", "collect-02", "spare-01"]);
    assert_eq!(list.active[0].identity.role, KeyRole::Collecting);
    assert_eq!(list.active[2].identity.role, KeyRole::Spare);
    assert_eq!(list.active[0].token_path, Path::new("/state/collector/collect-01/token.json"));
    assert_eq!(list.active[0].lock_path, Path::new("/state/collector/collect-01/collector.lock"));
    assert_eq!(list.active[0].app_key.expose(), "FAKE-APPKEY-AAAA");
    assert!(!format!("{list:?}").contains("FAKE-SECRET-VALUE-7777"));
    assert_eq!(list.identities().len(), 3);
}

#[test]
fn a_key_list_without_exactly_one_spare_is_refused() {
    let files = KeyFiles::new();
    let none = vec![files.entry(&KeySpec::new("collect-01", "FAKE-APPKEY-AAAA")), files.entry(&KeySpec::new("collect-02", "FAKE-APPKEY-BBBB"))];
    assert!(matches!(files.load(none, &Variables::new()), Err(KeysError::SpareCount(0))));
    let two = vec![
        files.entry(&KeySpec { spare: true, ..KeySpec::new("spare-01", "FAKE-APPKEY-AAAA") }),
        files.entry(&KeySpec { spare: true, ..KeySpec::new("spare-02", "FAKE-APPKEY-BBBB") }),
    ];
    assert!(matches!(files.load(two, &Variables::new()), Err(KeysError::SpareCount(2))));
}

#[test]
fn bad_names_and_repeated_names_are_refused() {
    let files = KeyFiles::new();
    let mut repeated = good_entries(&files);
    repeated.push(repeated[0].clone());
    assert!(matches!(files.load(repeated, &Variables::new()), Err(KeysError::DuplicateName(name)) if name.as_str() == "collect-01"));
    for bad in ["Collect-01", "collect_01", "수집", ""] {
        let mut entries = good_entries(&files);
        entries[0]["name"] = json!(bad);
        assert!(matches!(files.load(entries, &Variables::new()), Err(KeysError::BadName { .. })), "{bad:?}");
    }
}

#[test]
fn a_secret_file_other_users_can_read_is_refused() {
    let files = KeyFiles::new();
    let mut entries = good_entries(&files);
    entries[1] = files.entry(&KeySpec { mode: 0o644, ..KeySpec::new("collect-02", "FAKE-APPKEY-BBBB") });
    let error = files.load(entries, &Variables::new()).unwrap_err();
    assert!(matches!(&error, KeysError::SecretFile { key, .. } if key.as_str() == "collect-02"), "{error}");
    assert!(error.to_string().contains("collect-02") && error.to_string().contains("collect-02.env"), "{error}");
    assert_no_secret(&error);
}

#[test]
fn a_secret_file_missing_a_variable_is_refused_by_variable_name() {
    let files = KeyFiles::new();
    let entries = good_entries(&files);
    fs::write(files.secret_path("collect-01"), "VALLY_COLLECTOR_APP_KEY=FAKE-APPKEY-AAAA
").unwrap();
    let error = files.load(entries, &Variables::new()).unwrap_err();
    assert!(error.to_string().contains("VALLY_COLLECTOR_APP_SECRET"), "{error}");
    assert_no_secret(&error);
}

#[test]
fn an_app_key_whose_hash_differs_from_the_configured_hash_is_refused() {
    let files = KeyFiles::new();
    let mut entries = good_entries(&files);
    entries[0] = files.entry(&KeySpec { hash_of: "FAKE-APPKEY-OTHER", ..KeySpec::new("collect-01", "FAKE-APPKEY-AAAA") });
    let error = files.load(entries, &Variables::new()).unwrap_err();
    assert!(matches!(&error, KeysError::HashMismatch(key) if key.as_str() == "collect-01"), "{error}");
    assert_no_secret(&error);
}

#[test]
fn two_keys_with_the_same_app_key_are_refused() {
    let files = KeyFiles::new();
    let mut entries = good_entries(&files);
    entries[1] = files.entry(&KeySpec::new("collect-02", "FAKE-APPKEY-AAAA"));
    let error = files.load(entries, &Variables::new()).unwrap_err();
    assert!(matches!(&error, KeysError::SameAppKey { first, second } if first.as_str() == "collect-01" && second.as_str() == "collect-02"), "{error}");
    assert_no_secret(&error);
}

#[test]
fn the_app_server_key_is_refused_from_the_process_or_its_env_file() {
    let files = KeyFiles::new();
    let process: Variables = [("VALLY_KIWOOM_APP_KEY".to_owned(), "FAKE-APPKEY-BBBB".to_owned())].into();
    let error = files.load(good_entries(&files), &process).unwrap_err();
    assert!(matches!(&error, KeysError::AppServerKey { key, .. } if key.as_str() == "collect-02"), "{error}");
    assert_no_secret(&error);
    let app_env = files.folder.path().join("app.env");
    fs::write(&app_env, "VALLY_KIWOOM_APP_KEY=FAKE-APPKEY-CCCC
").unwrap();
    let process: Variables = [("VALLY_ENV_FILE".to_owned(), app_env.to_str().unwrap().to_owned())].into();
    let error = files.load(good_entries(&files), &process).unwrap_err();
    assert!(matches!(&error, KeysError::AppServerKey { key, .. } if key.as_str() == "spare-01"), "{error}");
    assert_no_secret(&error);
}

#[test]
fn the_excluded_and_unregistered_lists_are_in_code_order_whatever_the_universe_order() {
    let mut stocks: Vec<Entry> = (0..600).map(|number| entry(&code(number), true)).collect();
    stocks.extend([entry("999993", false), entry("999991", false), entry("999992", false)]);
    stocks.reverse();
    stocks.rotate_left(111);
    let plan = plan(&identities(3), &universe(stocks), &BTreeMap::new());
    let expected_excluded: Vec<String> = (570..600).map(code).collect();
    assert_eq!(plan.excluded, expected_excluded);
    assert_eq!(plan.unregistered, ["999991", "999992", "999993"]);
}

#[test]
fn a_key_takes_exactly_its_share_of_190_stocks() {
    assert_eq!(KEY_CAPACITY, 190);
    let full = plan(&identities(1), &universe_of(190), &BTreeMap::new());
    let collecting = full.keys.iter().find(|key| key.role == KeyRole::Collecting).unwrap();
    assert_eq!(collecting.stocks.len(), 190);
    assert!(full.excluded.is_empty() && full.alerts.is_empty());
    let over = plan(&identities(1), &universe_of(191), &BTreeMap::new());
    assert_eq!(over.excluded, [code(190)]);
    assert_eq!(over.keys.iter().map(|key| key.stocks.len()).max(), Some(190));
}

#[test]
fn the_check_allows_190_stocks_on_a_key_and_rejects_191() {
    let mut plan = plan(&identities(2), &universe_of(10), &BTreeMap::new());
    plan.keys[0].stocks = (0..190).map(code).collect();
    plan.keys[1].stocks.clear();
    assert_eq!(check_plan(&plan), Ok(()));
    plan.keys[0].stocks.push(code(190));
    assert!(matches!(check_plan(&plan), Err(Violation::KeyOverCapacity { stocks: 191, .. })));
}

#[test]
fn summing_loads_past_u64_does_not_panic_and_saturates() {
    let keys = identities(1);
    let universe = universe_of(3);
    let messages = BTreeMap::from([(code(0), u64::MAX), (code(1), u64::MAX), (code(2), 5)]);
    let plan = plan(&keys, &universe, &messages);
    let collecting = plan.keys.iter().find(|key| key.role == KeyRole::Collecting).unwrap();
    assert_eq!(collecting.stocks.len(), 3);
    assert_eq!(collecting.load, u64::MAX);
    assert_eq!(check_plan(&plan), Ok(()));
}

#[test]
fn a_plan_file_with_another_format_version_is_not_read() {
    let data = tempfile::tempdir().unwrap();
    let written = plan(&identities(2), &universe_of(10), &BTreeMap::new());
    let mut other = serde_json::to_value(&written).unwrap();
    other["format_version"] = json!(2);
    fs::create_dir_all(plan_path(data.path(), DATE).parent().unwrap()).unwrap();
    fs::write(plan_path(data.path(), DATE), other.to_string()).unwrap();
    let error = read_plan(data.path(), DATE).unwrap_err();
    assert!(matches!(&error, PlanError::Read { cause, .. } if cause.contains('2')), "{error}");
}

#[test]
fn a_missing_plan_file_is_a_read_error() {
    let data = tempfile::tempdir().unwrap();
    assert!(matches!(read_plan(data.path(), DATE), Err(PlanError::Read { .. })));
}

#[test]
fn a_secret_file_is_refused_for_group_or_other_access_and_accepted_when_only_the_owner_can_use_it() {
    for (mode, refused) in [(0o600, false), (0o400, false), (0o700, false), (0o640, true), (0o604, true), (0o660, true), (0o606, true), (0o610, true), (0o601, true), (0o670, true), (0o620, true), (0o602, true), (0o622, true)] {
        let files = KeyFiles::new();
        let mut entries = good_entries(&files);
        entries[0] = files.entry(&KeySpec { mode, ..KeySpec::new("collect-01", "FAKE-APPKEY-AAAA") });
        let result = files.load(entries, &Variables::new());
        match (refused, result) {
            (false, Ok(_)) => {}
            (true, Err(KeysError::SecretFile { problem, .. })) => assert_eq!(problem, collector::keys::SecretFileProblem::Mode(mode), "{mode:o}"),
            (_, other) => panic!("{mode:o}: {other:?}"),
        }
    }
}

#[test]
fn an_app_key_hash_must_be_sha256_prefix_and_64_lowercase_hex_characters() {
    let valid = format!("sha256:{}", "0123456789abcdef".repeat(4));
    let files = KeyFiles::new();
    let mut entries = good_entries(&files);
    entries[0]["app_key_hash"] = json!(valid);
    let error = files.load(entries, &Variables::new()).unwrap_err();
    assert!(matches!(error, KeysError::HashMismatch(_)), "형식은 맞아 키와의 대조까지 간다: {error}");
    let hex = "0123456789abcdef".repeat(4);
    let bad = [
        hex.clone(),
        format!("sha1:{hex}"),
        format!("sha256:{}", &hex[..63]),
        format!("sha256:{hex}0"),
        "sha256:".to_owned(),
        format!("sha256:g{}", &hex[1..]),
        format!("sha256:sha256:{hex}"),
        format!("sha256:{}", hex.to_uppercase()),
        format!("sha256:{}g", &hex[..63]),
        format!("sha256:{}", " ".repeat(64)),
        String::new(),
    ];
    for hash in bad {
        let mut entries = good_entries(&files);
        entries[0]["app_key_hash"] = json!(hash);
        let error = files.load(entries, &Variables::new()).unwrap_err();
        assert!(matches!(&error, KeysError::BadHash(key) if key.as_str() == "collect-01"), "{hash:?}: {error}");
    }
}

#[test]
fn a_secret_token_or_lock_path_must_be_absolute() {
    let files = KeyFiles::new();
    for field in ["secret_file", "token_path", "lock_path"] {
        let mut entries = good_entries(&files);
        entries[1][field] = json!("relative/path");
        let error = files.load(entries, &Variables::new()).unwrap_err();
        assert!(matches!(&error, KeysError::BadPath { key, path } if key.as_str() == "collect-02" && path == Path::new("relative/path")), "{field}: {error}");
    }
    let mut entries = good_entries(&files);
    entries[1]["token_path"] = json!("/custom/token.json");
    entries[1]["lock_path"] = json!("/custom/collector.lock");
    let list = files.load(entries, &Variables::new()).unwrap();
    assert_eq!(list.active[1].token_path, Path::new("/custom/token.json"));
    assert_eq!(list.active[1].lock_path, Path::new("/custom/collector.lock"));
}

#[test]
fn a_full_key_takes_no_more_even_when_its_load_is_the_lowest() {
    let keys = vec![identity("collect-01", KeyRole::Collecting), identity("collect-02", KeyRole::Collecting), identity("spare-01", KeyRole::Spare)];
    let mut messages: BTreeMap<String, u64> = (1..380).map(|number| (code(number), 1)).collect();
    messages.insert(code(0), 1000);
    let plan = plan(&keys, &universe_of(380), &messages);
    assert!(plan.excluded.is_empty());
    for key in plan.keys.iter().filter(|key| key.role == KeyRole::Collecting) {
        assert_eq!(key.stocks.len(), KEY_CAPACITY, "{}", key.name);
    }
    assert_eq!(check_plan(&plan), Ok(()));
}

#[test]
fn active_keys_come_back_in_name_order_from_any_file_order() {
    let files = KeyFiles::new();
    let mut entries = good_entries(&files);
    entries.reverse();
    let list = files.load(entries, &Variables::new()).unwrap();
    let names: Vec<&str> = list.active.iter().map(|key| key.identity.name.as_str()).collect();
    assert_eq!(names, ["collect-01", "collect-02", "spare-01"]);
}

#[test]
fn an_inactive_entry_with_a_bad_hash_is_refused() {
    let files = KeyFiles::new();
    let mut entries = good_entries(&files);
    entries.push(json!({"name": "later-01", "active": false, "spare": false, "app_key_hash": "not-a-hash", "secret_file": "/not/yet/there.env"}));
    let error = files.load(entries, &Variables::new()).unwrap_err();
    assert!(matches!(&error, KeysError::BadHash(key) if key.as_str() == "later-01"), "{error}");
}

#[test]
fn a_plan_file_with_format_version_zero_is_not_read() {
    let data = tempfile::tempdir().unwrap();
    let written = plan(&identities(2), &universe_of(10), &BTreeMap::new());
    let mut other = serde_json::to_value(&written).unwrap();
    other["format_version"] = json!(0);
    fs::create_dir_all(plan_path(data.path(), DATE).parent().unwrap()).unwrap();
    fs::write(plan_path(data.path(), DATE), other.to_string()).unwrap();
    assert!(matches!(read_plan(data.path(), DATE), Err(PlanError::Read { .. })));
}

#[test]
fn the_plan_file_is_json_under_the_plan_folder_named_by_date() {
    let data = Path::new("/state/collector");
    assert_eq!(plan_path(data, DATE), data.join("plan").join("20261118.json"));
}

fn share_of<'a>(plan: &'a PlanFile, name: &str) -> &'a KeyShare {
    plan.keys.iter().find(|key| key.name.as_str() == name).unwrap()
}

fn loads(values: &[(usize, u64)]) -> BTreeMap<String, u64> {
    values.iter().map(|(number, load)| (code(*number), *load)).collect()
}

fn codes(numbers: &[usize]) -> Vec<String> {
    numbers.iter().map(|number| code(*number)).collect()
}

fn two_collecting_keys() -> Vec<KeyIdentity> {
    vec![identity("collect-02", KeyRole::Collecting), identity("spare-01", KeyRole::Spare), identity("collect-01", KeyRole::Collecting)]
}

#[test]
fn stocks_with_the_same_load_are_dealt_in_code_order_and_equal_keys_go_to_the_first_name() {
    let messages = loads(&[(0, 10), (1, 10), (2, 10), (3, 10)]);
    let plan = plan(&two_collecting_keys(), &universe_of(4), &messages);
    assert_eq!(share_of(&plan, "collect-01").stocks, codes(&[0, 2]));
    assert_eq!(share_of(&plan, "collect-02").stocks, codes(&[1, 3]));
}

#[test]
fn stocks_without_any_count_alternate_between_equal_keys_starting_at_the_first_name() {
    let plan = plan(&two_collecting_keys(), &universe_of(5), &BTreeMap::new());
    assert_eq!(share_of(&plan, "collect-01").stocks, codes(&[0, 2, 4]));
    assert_eq!(share_of(&plan, "collect-02").stocks, codes(&[1, 3]));
}

#[test]
fn a_stock_with_a_count_of_one_goes_by_load_and_a_stock_with_no_count_goes_by_stock_count() {
    let messages = loads(&[(0, 100), (1, 3), (2, 3), (3, 3), (4, 1)]);
    let plan = plan(&two_collecting_keys(), &universe_of(6), &messages);
    assert_eq!(share_of(&plan, "collect-01").stocks, codes(&[0, 5]));
    assert_eq!(share_of(&plan, "collect-02").stocks, codes(&[1, 2, 3, 4]));
}

#[test]
fn a_stock_that_sent_nothing_yesterday_is_placed_like_one_with_no_count() {
    let messages = loads(&[(0, 100), (1, 3), (2, 3), (3, 3), (4, 1), (5, 0)]);
    let plan = plan(&two_collecting_keys(), &universe_of(6), &messages);
    assert_eq!(share_of(&plan, "collect-01").stocks, codes(&[0, 5]));
    assert_eq!(share_of(&plan, "collect-02").stocks, codes(&[1, 2, 3, 4]));
}

#[test]
fn a_stock_with_a_count_goes_to_the_fewer_stocks_when_loads_are_equal() {
    let messages = loads(&[(0, 9), (1, 6), (2, 5), (3, 1), (4, 1), (5, 1)]);
    let plan = plan(&two_collecting_keys(), &universe_of(6), &messages);
    assert_eq!(share_of(&plan, "collect-01").stocks, codes(&[0, 3, 4]));
    assert_eq!(share_of(&plan, "collect-02").stocks, codes(&[1, 2, 5]));
}

#[test]
fn the_market_types_go_to_the_lightest_collecting_key_then_the_one_with_fewer_stocks_then_the_first_name() {
    let heavy_few = loads(&[(0, 100), (1, 3), (2, 3), (3, 3), (4, 1)]);
    let by_load = plan(&two_collecting_keys(), &universe_of(5), &heavy_few);
    assert_eq!(share_of(&by_load, "collect-02").market_types, MARKET_TYPES);
    assert!(share_of(&by_load, "collect-01").market_types.is_empty());

    let equal_load_fewer_stocks = plan(&two_collecting_keys(), &universe_of(3), &BTreeMap::new());
    assert_eq!(share_of(&equal_load_fewer_stocks, "collect-01").stocks.len(), 2);
    assert_eq!(share_of(&equal_load_fewer_stocks, "collect-02").market_types, MARKET_TYPES);
    assert!(share_of(&equal_load_fewer_stocks, "collect-01").market_types.is_empty());

    let equal_everything = plan(&two_collecting_keys(), &universe_of(2), &BTreeMap::new());
    assert_eq!(share_of(&equal_everything, "collect-01").market_types, MARKET_TYPES);
    assert!(share_of(&equal_everything, "collect-02").market_types.is_empty());
    assert!(share_of(&equal_everything, "spare-01").market_types.is_empty());
}

#[test]
fn the_stocks_on_every_key_are_listed_in_code_order() {
    let plan = plan(&identities(3), &universe_of(570), &uneven_messages(570));
    for key in &plan.keys {
        let mut sorted = key.stocks.clone();
        sorted.sort();
        assert_eq!(key.stocks, sorted, "{}", key.name);
    }
}

#[test]
fn the_alert_for_excluded_stocks_counts_the_keys_needed_rounded_up() {
    let plan = plan(&identities(3), &universe_of(600), &BTreeMap::new());
    assert_eq!(
        plan.alerts,
        ["등록할 종목 600개가 수집 키 3개의 몫 570개를 넘어 종목코드 순서로 30개(000571~000600)를 제외했습니다. 수집 키가 4개 필요합니다"]
    );
    let exact = self::plan(&identities(3), &universe_of(760), &BTreeMap::new());
    assert_eq!(
        exact.alerts,
        ["등록할 종목 760개가 수집 키 3개의 몫 570개를 넘어 종목코드 순서로 190개(000571~000760)를 제외했습니다. 수집 키가 4개 필요합니다"]
    );
    let one_over = self::plan(&identities(3), &universe_of(761), &BTreeMap::new());
    assert!(one_over.alerts[0].ends_with("수집 키가 5개 필요합니다"), "{:?}", one_over.alerts);
}

#[test]
fn a_plan_without_a_spare_key_alerts_that_no_handoff_is_possible() {
    let keys: Vec<KeyIdentity> = identities(2).into_iter().filter(|key| key.role == KeyRole::Collecting).collect();
    let plan = plan(&keys, &universe_of(10), &BTreeMap::new());
    assert_eq!(plan.alerts, ["활성 예비 키가 없어 인계할 수 없습니다"]);
}

fn valid_plan() -> PlanFile {
    let valid = plan(&identities(2), &universe_of(10), &BTreeMap::new());
    assert_eq!(check_plan(&valid), Ok(()));
    valid
}

fn spare_of(plan: &mut PlanFile) -> &mut KeyShare {
    plan.keys.iter_mut().find(|key| key.role == KeyRole::Spare).unwrap()
}

#[test]
fn the_check_rejects_a_key_listed_twice() {
    let mut plan = valid_plan();
    let again = spare_of(&mut plan).clone();
    plan.keys.push(again);
    assert_eq!(check_plan(&plan), Err(Violation::DuplicateKey(KeyName::parse("spare-01").unwrap())));
    let mut collecting = valid_plan();
    let mut again = collecting.keys[0].clone();
    again.stocks.clear();
    again.market_types.clear();
    collecting.keys.push(again);
    assert_eq!(check_plan(&collecting), Err(Violation::DuplicateKey(KeyName::parse("collect-01").unwrap())));
}

#[test]
fn the_check_rejects_each_kind_of_work_on_the_spare() {
    let spare_name = KeyName::parse("spare-01").unwrap();

    let mut with_stock = valid_plan();
    let moved = with_stock.keys[0].stocks.pop().unwrap();
    spare_of(&mut with_stock).stocks.push(moved);
    assert_eq!(check_plan(&with_stock), Err(Violation::SpareHoldsWork(spare_name.clone())));

    let mut with_market_types = valid_plan();
    let holder = with_market_types.keys.iter_mut().find(|key| !key.market_types.is_empty()).unwrap();
    let moved = std::mem::take(&mut holder.market_types);
    spare_of(&mut with_market_types).market_types = moved;
    assert_eq!(check_plan(&with_market_types), Err(Violation::SpareHoldsWork(spare_name.clone())));

    let mut with_one_market_type_too = valid_plan();
    spare_of(&mut with_one_market_type_too).market_types.push(MARKET_TYPES[1]);
    assert_eq!(check_plan(&with_one_market_type_too), Err(Violation::SpareHoldsWork(spare_name.clone())));

    let mut with_rest_job = valid_plan();
    spare_of(&mut with_rest_job).rest_jobs.push("ka10081".to_owned());
    assert_eq!(check_plan(&with_rest_job), Err(Violation::SpareHoldsWork(spare_name)));
}

#[test]
fn the_check_rejects_a_placed_stock_that_is_also_excluded_or_unregistered() {
    let placed = code(0);
    let holder = plan(&identities(2), &universe_of(10), &BTreeMap::new()).keys.iter().find(|key| key.stocks.contains(&placed)).unwrap().name.clone();

    let mut also_excluded = valid_plan();
    also_excluded.excluded.push(placed.clone());
    assert_eq!(check_plan(&also_excluded), Err(Violation::StockAlsoUnplaced { code: placed.clone(), key: holder.clone() }));

    let mut also_unregistered = valid_plan();
    also_unregistered.unregistered.push(placed.clone());
    assert_eq!(check_plan(&also_unregistered), Err(Violation::StockAlsoUnplaced { code: placed, key: holder }));

    let mut apart = valid_plan();
    apart.excluded.push("999990".to_owned());
    apart.unregistered.push("999991".to_owned());
    assert_eq!(check_plan(&apart), Ok(()));
}

#[test]
fn the_check_rejects_a_market_type_on_no_key_and_on_two_keys_for_each_of_the_three_types() {
    for market_type in MARKET_TYPES {
        let mut missing = valid_plan();
        for key in &mut missing.keys {
            key.market_types.retain(|held| *held != market_type);
        }
        assert_eq!(check_plan(&missing), Err(Violation::MarketTypeCount { market_type: market_type.wire(), keys: 0 }), "{}", market_type.wire());

        let mut doubled = valid_plan();
        let other = doubled.keys.iter_mut().find(|key| key.market_types.is_empty() && key.role == KeyRole::Collecting).unwrap();
        other.market_types.push(market_type);
        assert_eq!(check_plan(&doubled), Err(Violation::MarketTypeCount { market_type: market_type.wire(), keys: 2 }), "{}", market_type.wire());
    }
}
