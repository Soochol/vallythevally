use std::sync::{Arc, Mutex};
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

struct Scoped<T> {
    filled_in: Option<GenerationTicket>,
    value: T,
}

pub struct GenerationScoped<T> {
    generation: SourceGeneration,
    scoped: Mutex<Scoped<T>>,
}

impl<T: Default> GenerationScoped<T> {
    pub fn new(generation: SourceGeneration) -> GenerationScoped<T> {
        GenerationScoped { generation, scoped: Mutex::new(Scoped { filled_in: None, value: T::default() }) }
    }

    pub fn ticket(&self) -> GenerationTicket {
        self.generation.ticket()
    }

    pub fn read<R>(&self, use_value: impl FnOnce(&mut T) -> R) -> R {
        let mut scoped = self.scoped.lock().expect("세대 캐시 잠금");
        let current = self.generation.ticket();
        Self::roll(&mut scoped, current);
        use_value(&mut scoped.value)
    }

    pub fn keep<R>(&self, started: GenerationTicket, use_value: impl FnOnce(&mut T) -> R) -> Option<R> {
        let mut scoped = self.scoped.lock().expect("세대 캐시 잠금");
        let current = self.generation.ticket();
        Self::roll(&mut scoped, current);
        (started == current).then(|| use_value(&mut scoped.value))
    }

    fn roll(scoped: &mut Scoped<T>, current: GenerationTicket) {
        if scoped.filled_in != Some(current) {
            scoped.filled_in = Some(current);
            scoped.value = T::default();
        }
    }
}
