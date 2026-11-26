use super::model::{AlertDispatch, DispatchKind, Fingerprint, Severity};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormattedMessage {
    pub html: String,
    pub plain: String,
    pub silent: bool,
    pub severity: Severity,
    pub fingerprint: Fingerprint,
}

pub fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            other => escaped.push(other),
        }
    }
    escaped
}

pub fn format_duration(secs: u64) -> String {
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;
    match (hours, minutes, seconds) {
        (0, 0, s) => format!("{s}초"),
        (0, m, 0) => format!("{m}분"),
        (0, m, s) => format!("{m}분 {s}초"),
        (h, 0, _) => format!("{h}시간"),
        (h, m, _) => format!("{h}시간 {m}분"),
    }
}

fn header_tag(kind: DispatchKind, severity: Severity) -> (&'static str, &'static str) {
    match kind {
        DispatchKind::Resolved => ("🟢", "복구 완료"),
        DispatchKind::Escalated => ("🔴", "P1 승격"),
        DispatchKind::Reminder => (severity.badge(), "미해결 재알림"),
        DispatchKind::Digest => (severity.badge(), severity.label()),
        DispatchKind::Fired => (severity.badge(), severity.label()),
    }
}

pub fn render_dispatch(dispatch: &AlertDispatch) -> FormattedMessage {
    let (badge, tag) = header_tag(dispatch.kind, dispatch.severity);
    let stamp = dispatch.observed_at.to_string();
    let target = format!("{}/{}", dispatch.fingerprint.source.as_str(), dispatch.fingerprint.target);
    let short_id = dispatch.fingerprint.short_id();

    let mut html_lines = Vec::new();
    let mut plain_lines = Vec::new();

    html_lines.push(format!("{badge} <b>[{tag}] {}</b>", escape_html(&dispatch.title)));
    plain_lines.push(format!("[{tag}] {}", dispatch.title));

    html_lines.push(format!("시각: {stamp} · 대상: <code>{}</code>", escape_html(&target)));
    plain_lines.push(format!("시각: {stamp} · 대상: {target}"));

    if let Some(secs) = dispatch.duration_secs {
        let duration = format_duration(secs);
        if dispatch.suppressed_count > 0 {
            html_lines.push(format!("지속시간: <b>{duration}</b> (억제된 중복 {}건)", dispatch.suppressed_count));
            plain_lines.push(format!("지속시간: {duration} (억제된 중복 {}건)", dispatch.suppressed_count));
        } else {
            html_lines.push(format!("지속시간: <b>{duration}</b>"));
            plain_lines.push(format!("지속시간: {duration}"));
        }
    } else if dispatch.suppressed_count > 0 && dispatch.kind == DispatchKind::Reminder {
        html_lines.push(format!("누적 중복 억제: {}건", dispatch.suppressed_count));
        plain_lines.push(format!("누적 중복 억제: {}건", dispatch.suppressed_count));
    }

    if !dispatch.summary.is_empty() {
        html_lines.push(format!("내용: {}", escape_html(&dispatch.summary)));
        plain_lines.push(format!("내용: {}", dispatch.summary));
    }

    for (key, value) in &dispatch.metrics {
        html_lines.push(format!("• {}: <b>{}</b>", escape_html(key), escape_html(value)));
        plain_lines.push(format!("- {key}: {value}"));
    }

    if !dispatch.impact.is_empty() {
        html_lines.push(format!("영향: {}", escape_html(&dispatch.impact)));
        plain_lines.push(format!("영향: {}", dispatch.impact));
    }

    if let Some(action) = &dispatch.action {
        html_lines.push(format!("조치: <code>{}</code>", escape_html(action)));
        plain_lines.push(format!("조치: {action}"));
    }

    if dispatch.kind != DispatchKind::Digest {
        html_lines.push(format!("<code>#{short_id}</code>"));
        plain_lines.push(format!("#{short_id}"));
    }

    FormattedMessage {
        html: html_lines.join("\n"),
        plain: plain_lines.join("\n"),
        silent: dispatch.silent,
        severity: dispatch.severity,
        fingerprint: dispatch.fingerprint.clone(),
    }
}
