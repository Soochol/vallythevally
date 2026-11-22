use collector::shared::rankings::{Owner, owner_of};

#[test]
fn conditions_only_one_key_can_take_always_go_to_it() {
    let second_only = [false, true];
    assert!((0..40).all(|condition| owner_of(condition, &second_only) == Owner::Key(1)));
}

#[test]
fn conditions_are_split_evenly_among_capable_keys() {
    let can = [true, false, true];
    let owners: Vec<Owner> = (0..4).map(|condition| owner_of(condition, &can)).collect();
    assert_eq!(owners, [Owner::Key(0), Owner::Key(2), Owner::Key(0), Owner::Key(2)]);
}

#[test]
fn a_condition_nobody_can_take_has_no_owner() {
    assert_eq!(owner_of(3, &[false, false]), Owner::Nobody);
    assert_eq!(owner_of(3, &[]), Owner::Nobody);
}

#[test]
fn every_key_computes_the_same_owner_for_every_condition() {
    let can = [true, true, false, true];
    for condition in 0..30 {
        let owner = owner_of(condition, &can);
        let Owner::Key(index) = owner else { panic!("받을 수 있는 키가 있다") };
        assert!(can[index]);
    }
}
