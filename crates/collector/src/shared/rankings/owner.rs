#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Key(usize),
    Nobody,
}

pub fn owner_of(condition_index: usize, key_can_take: &[bool]) -> Owner {
    let capable: Vec<usize> = key_can_take.iter().enumerate().filter(|(_, can)| **can).map(|(index, _)| index).collect();
    match capable.len() {
        0 => Owner::Nobody,
        count => Owner::Key(capable[condition_index % count]),
    }
}
