pub struct Asset {
    pub path: &'static str,
    pub content_type: &'static str,
    pub bytes: &'static [u8],
}

const HTML: &str = "text/html; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";
const JAVASCRIPT: &str = "text/javascript; charset=utf-8";

pub const ASSETS: &[Asset] = &[
    Asset { path: "/", content_type: HTML, bytes: include_bytes!("../../page/index.html") },
    Asset { path: "/style.css", content_type: CSS, bytes: include_bytes!("../../page/style.css") },
    Asset { path: "/main.js", content_type: JAVASCRIPT, bytes: include_bytes!("../../page/main.js") },
    Asset { path: "/worker.js", content_type: JAVASCRIPT, bytes: include_bytes!("../../page/worker.js") },
    Asset { path: "/decode.js", content_type: JAVASCRIPT, bytes: include_bytes!("../../page/decode.js") },
    Asset { path: "/seek.js", content_type: JAVASCRIPT, bytes: include_bytes!("../../page/seek.js") },
    Asset { path: "/replay.js", content_type: JAVASCRIPT, bytes: include_bytes!("../../page/replay.js") },
    Asset { path: "/view.js", content_type: JAVASCRIPT, bytes: include_bytes!("../../page/view.js") },
];

pub fn find(path: &str) -> Option<&'static Asset> {
    ASSETS.iter().find(|asset| asset.path == path)
}
