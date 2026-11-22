#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KisApiId {
    CurrentPrice,
}

impl KisApiId {
    pub const ALL: [KisApiId; 1] = [KisApiId::CurrentPrice];

    pub fn tr_id(self) -> &'static str {
        match self {
            KisApiId::CurrentPrice => "FHKST01010100",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            KisApiId::CurrentPrice => "/uapi/domestic-stock/v1/quotations/inquire-price",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_api_has_a_distinct_tr_id_and_a_quotation_path() {
        let mut seen = std::collections::HashSet::new();
        for api in KisApiId::ALL {
            assert!(seen.insert(api.tr_id()), "{api:?}");
            assert!(api.path().starts_with("/uapi/domestic-stock/v1/quotations/"), "{api:?}");
        }
    }
}
