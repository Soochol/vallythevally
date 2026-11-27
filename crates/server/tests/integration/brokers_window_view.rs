use serde_json::{Value, json};
use server::api::LayoutWindow;

fn window(extra: Value) -> Value {
    let mut window = json!({"id": "w1", "link": null, "kind": "brokers"});
    for (key, value) in extra.as_object().unwrap() {
        window[key] = value.clone();
    }
    window
}

#[test]
fn brokers_window_keeps_its_view_and_old_windows_have_none() {
    let chosen = window(json!({"symbol": "005930", "view": "list", "cards": "numbers"}));
    let read: LayoutWindow = serde_json::from_value(chosen.clone()).unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), chosen);

    let other = window(json!({"view": "board", "cards": "bars"}));
    let read: LayoutWindow = serde_json::from_value(other.clone()).unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), other);

    let table = window(json!({"view": "table"}));
    let read: LayoutWindow = serde_json::from_value(table.clone()).unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), table);

    let transfer = window(json!({"view": "transfer"}));
    let read: LayoutWindow = serde_json::from_value(transfer.clone()).unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), transfer);

    let old = window(json!({}));
    let read: LayoutWindow = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), old);

    assert!(serde_json::from_value::<LayoutWindow>(window(json!({"view": "grid"}))).is_err());
    assert!(serde_json::from_value::<LayoutWindow>(window(json!({"cards": "pie"}))).is_err());
}
