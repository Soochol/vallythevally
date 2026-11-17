use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use collector::collect::config::Variables;
use collector::keys::{KeyIdentity, KeyList, KeyRole, KeysError};
use collector::kst::KstTime;
use collector::plan::{
    KEY_CAPACITY, MARKET_TYPES, PlanError, PlanFile, PlanInput, Violation, build_plan, check_plan, plan_path, read_plan, write_plan,
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
    build_plan(&PlanInput { date: DATE, created_at: KstTime { date: DATE, ms_of_day: 7 * 3_600_000 + 35 * 60_000 }, keys, universe, previous_messages: messages }).unwrap()
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
