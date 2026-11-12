use super::client::Fault;
use super::model::{Failure, Interrupt};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Disposition { StopJob, AbortJob, Record }

pub(super) fn disposition(failure: Failure) -> Disposition {
    match failure {
        Failure::Authentication | Failure::RateLimited => Disposition::StopJob,
        Failure::Storage => Disposition::AbortJob,
        Failure::Network | Failure::Remote | Failure::InvalidResponse | Failure::SourceUnavailable | Failure::ReceiptMismatch => Disposition::Record,
    }
}

impl Failure {
    pub(super) fn recorded(self) -> Result<Failure, Interrupt> {
        if disposition(self) == Disposition::Record { Ok(self) } else { Err(Interrupt::Abort(self)) }
    }
}

impl Fault {
    pub(super) fn recorded(self) -> Result<Failure, Interrupt> {
        match self { Fault::Halt(halt) => Err(Interrupt::Halt(halt)), Fault::Failure(failure) => failure.recorded() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::model::Halt;

    #[test]
    fn disposition_stops_on_source_refusals_aborts_on_storage_and_records_the_rest() {
        for (failure, expected) in [
            (Failure::Authentication, Disposition::StopJob),
            (Failure::RateLimited, Disposition::StopJob),
            (Failure::Storage, Disposition::AbortJob),
            (Failure::Network, Disposition::Record),
            (Failure::Remote, Disposition::Record),
            (Failure::InvalidResponse, Disposition::Record),
            (Failure::SourceUnavailable, Disposition::Record),
            (Failure::ReceiptMismatch, Disposition::Record),
        ] { assert_eq!(disposition(failure), expected, "{failure:?}"); }
    }

    #[test]
    fn faults_become_recorded_failures_or_job_interrupts() {
        assert_eq!(Fault::Halt(Halt::Paused).recorded(), Err(Interrupt::Halt(Halt::Paused)));
        assert_eq!(Fault::Halt(Halt::Yielded).recorded(), Err(Interrupt::Halt(Halt::Yielded)));
        assert_eq!(Fault::Failure(Failure::Storage).recorded(), Err(Interrupt::Abort(Failure::Storage)));
        assert_eq!(Fault::Failure(Failure::RateLimited).recorded(), Err(Interrupt::Abort(Failure::RateLimited)));
        assert_eq!(Fault::Failure(Failure::Remote).recorded(), Ok(Failure::Remote));
    }
}
