#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Number(i64),
    Text(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn parse(text: &str) -> Json {
        let mut parser = Parser { bytes: text.as_bytes(), at: 0 };
        let value = parser.value();
        parser.skip_space();
        assert_eq!(parser.at, parser.bytes.len(), "JSON 뒤에 글자가 남았다");
        value
    }

    pub fn field(&self, name: &str) -> &Json {
        match self {
            Json::Object(fields) => fields
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value)
                .unwrap_or_else(|| panic!("{name} 필드가 없다")),
            other => panic!("객체가 아니다: {other:?}"),
        }
    }

    pub fn number(&self) -> i64 {
        match self {
            Json::Number(value) => *value,
            other => panic!("숫자가 아니다: {other:?}"),
        }
    }

    pub fn text(&self) -> &str {
        match self {
            Json::Text(value) => value,
            other => panic!("글자가 아니다: {other:?}"),
        }
    }

    pub fn array(&self) -> &[Json] {
        match self {
            Json::Array(items) => items,
            other => panic!("배열이 아니다: {other:?}"),
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn skip_space(&mut self) {
        while self.at < self.bytes.len() && self.bytes[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) {
        self.skip_space();
        assert_eq!(self.bytes[self.at], byte, "{}번째 글자", self.at);
        self.at += 1;
    }

    fn peek(&mut self) -> u8 {
        self.skip_space();
        self.bytes[self.at]
    }

    fn value(&mut self) -> Json {
        match self.peek() {
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                while self.peek() != b']' {
                    items.push(self.value());
                    if self.peek() == b',' {
                        self.at += 1;
                    }
                }
                self.at += 1;
                Json::Array(items)
            }
            b'{' => {
                self.at += 1;
                let mut fields = Vec::new();
                while self.peek() != b'}' {
                    let key = self.string();
                    self.expect(b':');
                    fields.push((key, self.value()));
                    if self.peek() == b',' {
                        self.at += 1;
                    }
                }
                self.at += 1;
                Json::Object(fields)
            }
            b'"' => Json::Text(self.string()),
            _ => {
                let start = self.at;
                while self.at < self.bytes.len()
                    && (self.bytes[self.at] == b'-' || self.bytes[self.at].is_ascii_digit())
                {
                    self.at += 1;
                }
                let digits = std::str::from_utf8(&self.bytes[start..self.at]).unwrap();
                Json::Number(digits.parse().expect("정수가 아니다"))
            }
        }
    }

    fn string(&mut self) -> String {
        self.expect(b'"');
        let start = self.at;
        while self.bytes[self.at] != b'"' {
            assert_ne!(self.bytes[self.at], b'\\', "이스케이프는 지원하지 않는다");
            self.at += 1;
        }
        let text = std::str::from_utf8(&self.bytes[start..self.at]).unwrap().to_string();
        self.at += 1;
        text
    }
}
