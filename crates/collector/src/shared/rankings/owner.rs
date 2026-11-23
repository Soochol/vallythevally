use server::shared_data::Broker;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Key(usize),
    Nobody,
}

pub fn owner_of(condition_index: usize, peers: &[Broker], can_take: impl Fn(Broker) -> bool) -> Owner {
    let Some(first) = peers.iter().position(|broker| can_take(*broker)) else { return Owner::Nobody };
    let tier: Vec<usize> = peers.iter().enumerate().filter(|(_, broker)| **broker == peers[first]).map(|(index, _)| index).collect();
    Owner::Key(tier[condition_index % tier.len()])
}
