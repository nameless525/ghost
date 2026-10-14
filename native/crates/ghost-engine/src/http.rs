//! Blocking HTTP client (ureq + rustls) shared by the stream cache, downloads and cover fetches.

use std::io::Read;
use std::time::Duration;

pub struct Http {
    agent: ureq::Agent,
    user_agent: String,
}

pub type Response = ureq::http::Response<ureq::Body>;

#[derive(Debug)]
pub enum HttpError {
    /// Worth retrying (network error, 5xx, 429).
    Transient(String),
    /// Retrying won't help (404, 403, bad URL).
    Fatal(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Transient(m) | HttpError::Fatal(m) => f.write_str(m),
        }
    }
}

impl Http {
    pub fn new(user_agent: &str) -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(15)))
            .max_redirects(10)
            .build();
        Self { agent: ureq::Agent::new_with_config(config), user_agent: user_agent.to_string() }
    }

    /// GET with optional byte range (`[start, end_inclusive]`, end None = open-ended) and a body
    /// timeout. Status codes are returned, not turned into errors.
    pub fn get(
        &self,
        url: &str,
        headers: &[(String, String)],
        range: Option<(u64, Option<u64>)>,
        body_timeout: Option<Duration>,
    ) -> Result<Response, HttpError> {
        let mut req = self.agent.get(url);
        let has_ua = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("user-agent"));
        if !has_ua && !self.user_agent.is_empty() {
            req = req.header("User-Agent", self.user_agent.as_str());
        }
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("accept-encoding")) {
            // Byte ranges must address the raw file, never a compressed transfer encoding.
            req = req.header("Accept-Encoding", "identity");
        }
        if let Some((start, end)) = range {
            let value = match end {
                Some(e) => format!("bytes={start}-{e}"),
                None => format!("bytes={start}-"),
            };
            req = req.header("Range", value);
        }
        let req = req.config().timeout_recv_body(body_timeout).build();
        req.call().map_err(|e| match e {
            ureq::Error::BadUri(m) => HttpError::Fatal(format!("bad url: {m}")),
            ureq::Error::Http(e) => HttpError::Fatal(format!("http: {e}")),
            other => HttpError::Transient(other.to_string()),
        })
    }

    /// Fetch a small resource (e.g. cover art) fully into memory.
    pub fn get_bytes(&self, url: &str, limit: u64) -> Result<Vec<u8>, HttpError> {
        let resp = self.get(url, &[], None, Some(Duration::from_secs(30)))?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(classify_status(status));
        }
        let mut out = Vec::new();
        resp.into_body()
            .into_reader()
            .take(limit)
            .read_to_end(&mut out)
            .map_err(|e| HttpError::Transient(format!("read: {e}")))?;
        Ok(out)
    }
}

pub fn classify_status(status: u16) -> HttpError {
    match status {
        408 | 425 | 429 | 500..=599 => HttpError::Transient(format!("HTTP {status}")),
        _ => HttpError::Fatal(format!("HTTP {status}")),
    }
}

pub fn header_str<'a>(resp: &'a Response, name: &str) -> Option<&'a str> {
    resp.headers().get(name).and_then(|v| v.to_str().ok())
}

/// Parse `Content-Range: bytes a-b/total` → (a, b, total?). `bytes */total` → (None, total).
/// (first, last) byte positions of a range.
pub type ByteSpan = (u64, u64);

pub fn parse_content_range(v: &str) -> Option<(Option<ByteSpan>, Option<u64>)> {
    let v = v.trim().strip_prefix("bytes")?.trim();
    let (range, total) = v.split_once('/')?;
    let total = total.trim().parse::<u64>().ok();
    let range = range.trim();
    if range == "*" {
        return Some((None, total));
    }
    let (a, b) = range.split_once('-')?;
    Some((Some((a.trim().parse().ok()?, b.trim().parse().ok()?)), total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range() {
        assert_eq!(parse_content_range("bytes 0-99/1000"), Some((Some((0, 99)), Some(1000))));
        assert_eq!(parse_content_range("bytes 5-9/*"), Some((Some((5, 9)), None)));
        assert_eq!(parse_content_range("bytes */77"), Some((None, Some(77))));
        assert_eq!(parse_content_range("items 1-2/3"), None);
    }
}
