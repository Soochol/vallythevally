#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StreamKind {
    Book = 1,
    Trades = 2,
    Program = 3,
    Broker = 4,
    Gaps = 5,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnSpec {
    pub name: String,
    pub delta: bool,
}

impl StreamKind {
    pub const ALL: [StreamKind; 5] = [
        StreamKind::Book,
        StreamKind::Trades,
        StreamKind::Program,
        StreamKind::Broker,
        StreamKind::Gaps,
    ];

    pub fn code(self) -> u8 {
        self as u8
    }

    pub fn from_code(code: u8) -> Option<StreamKind> {
        StreamKind::ALL.into_iter().find(|kind| kind.code() == code)
    }

    pub fn name(self) -> &'static str {
        match self {
            StreamKind::Book => "book",
            StreamKind::Trades => "trades",
            StreamKind::Program => "program",
            StreamKind::Broker => "broker",
            StreamKind::Gaps => "gaps",
        }
    }

    pub fn columns(self) -> Vec<ColumnSpec> {
        match self {
            StreamKind::Book => {
                let mut columns = delta_columns(&["recv_ms", "t_s"]);
                for prefix in ["ask_px", "bid_px", "ask_qty", "bid_qty"] {
                    columns.extend(numbered(prefix, 10, true));
                }
                columns.extend(delta_columns(&["ask_total", "bid_total"]));
                columns
            }
            StreamKind::Trades => vec![
                column("recv_ms", true),
                column("t_s", true),
                column("price", true),
                column("qty", false),
                column("venue", false),
            ],
            StreamKind::Program => {
                delta_columns(&["recv_ms", "t_s", "sell_qty", "sell_amt", "buy_qty", "buy_amt"])
            }
            StreamKind::Broker => {
                let mut columns = vec![column("recv_ms", true)];
                for prefix in ["sell_code", "buy_code", "sell_qty", "buy_qty"] {
                    columns.extend(numbered(prefix, 5, false));
                }
                columns
            }
            StreamKind::Gaps => vec![column("from_ms", false), column("to_ms", false)],
        }
    }

    pub fn column_index(self, name: &str) -> Option<usize> {
        self.columns().iter().position(|spec| spec.name == name)
    }
}

fn column(name: &str, delta: bool) -> ColumnSpec {
    ColumnSpec {
        name: name.to_string(),
        delta,
    }
}

fn delta_columns(names: &[&str]) -> Vec<ColumnSpec> {
    names.iter().map(|name| column(name, true)).collect()
}

fn numbered(prefix: &str, count: usize, delta: bool) -> Vec<ColumnSpec> {
    (1..=count)
        .map(|level| column(&format!("{prefix}{level}"), delta))
        .collect()
}
