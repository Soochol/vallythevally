use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Default)]
pub struct SourceGeneration(Arc<AtomicU64>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GenerationTicket(u64);

impl GenerationTicket {
    pub fn number(self) -> u64 {
        self.0
    }
}

impl SourceGeneration {
    pub fn ticket(&self) -> GenerationTicket {
        GenerationTicket(self.0.load(Ordering::SeqCst))
    }

    pub fn is_current(&self, ticket: GenerationTicket) -> bool {
        self.ticket() == ticket
    }

    pub fn advance(&self) -> GenerationTicket {
        GenerationTicket(self.0.fetch_add(1, Ordering::SeqCst) + 1)
    }
}
