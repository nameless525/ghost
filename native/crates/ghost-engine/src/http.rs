//! Blocking HTTP client (ureq + rustls) shared by the stream cache, downloads and cover fetches.
//!
//! Every response is given up once nothing arrives for `IDLE_TIMEOUT`: ureq's timeouts are
//! deadlines for a whole phase, which a long body can't have. A thread can also make its
//! requests give way at once to something else (see [`interruptible`]). Both are checked on the
//! socket (below TLS) while it waits for bytes, every `POLL`.

use std::cell::RefCell;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use ureq::unversioned::resolver::DefaultResolver;
use ureq::unversioned::transport::time::Duration as UreqDuration;
use ureq::unversioned::transport::{Buffers, ConnectProxyConnector, ConnectionDetails, Connector, Either, LazyBuffers, NextTimeout, RustlsConnector, Transport};

/// A response that sends nothing for this long is dropped. Every byte restarts it, so a slow
/// download that keeps coming is fine.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(15);
/// How often a request waiting for bytes checks its idle time and interrupt.
const POLL: Duration = Duration::from_millis(100);

thread_local! {
    /// Checked by this thread's requests while they wait for bytes (see [`interruptible`]).
    static INTERRUPT: RefCell<Option<Box<dyn Fn() -> bool>>> = const { RefCell::new(None) };
}

/// Run `f`; a request it makes on this thread that is waiting for bytes fails as soon as
/// `interrupted` returns true (within `POLL`), dropping its connection.
pub fn interruptible<R>(interrupted: impl Fn() -> bool + 'static, f: impl FnOnce() -> R) -> R {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            INTERRUPT.with(|i| *i.borrow_mut() = None);
        }
    }
    INTERRUPT.with(|i| *i.borrow_mut() = Some(Box::new(interrupted)));
    let _reset = Reset;
    f()
}

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
        Self::with_idle_timeout(user_agent, IDLE_TIMEOUT)
    }

    pub(crate) fn with_idle_timeout(user_agent: &str, idle: Duration) -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(15)))
            .max_redirects(10)
            // Keep idle connections (and with them TCP + TLS setup) for the next request: the
            // next range of the same stream, or the next track from the same host a minute later.
            // Pooled connections are checked for liveness before reuse.
            .max_idle_age(Duration::from_secs(90))
            .max_idle_connections_per_host(4)
            .build();
        // ureq's default chain (HTTP proxy, TCP, TLS), its sockets watched.
        let connector = ().chain(ConnectProxyConnector::default()).chain(WatchedTcp(idle)).chain(RustlsConnector::default());
        Self { agent: ureq::Agent::with_parts(config, connector, DefaultResolver::default()), user_agent: user_agent.to_string() }
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

/// Opens TCP connections like ureq's own connector, as [`Watched`] sockets; `.0` is the idle limit.
#[derive(Debug)]
struct WatchedTcp(Duration);

impl<In: Transport> Connector<In> for WatchedTcp {
    type Out = Either<In, Watched>;

    fn connect(&self, details: &ConnectionDetails, chained: Option<In>) -> Result<Option<Self::Out>, ureq::Error> {
        if chained.is_some() {
            // Through an HTTP proxy, whose own socket was opened (and is watched) here too.
            return Ok(chained.map(Either::A));
        }
        let stream = connect(details)?;
        let buffers = LazyBuffers::new(details.config.input_buffer_size(), details.config.output_buffer_size());
        Ok(Some(Either::B(Watched { stream, buffers, idle: self.0 })))
    }
}

/// Connect to the first resolved address that answers, each getting half the time left (the
/// last all of it), as ureq's own connector shares it.
fn connect(details: &ConnectionDetails) -> Result<TcpStream, ureq::Error> {
    let budget = details.timeout.not_zero().map(|d| *d);
    let started = Instant::now();
    let addrs = &details.addrs[..];
    let mut last = None;
    for (i, addr) in addrs.iter().enumerate() {
        let attempt = match budget.map(|b| b.saturating_sub(started.elapsed())) {
            Some(left) if left.is_zero() => break,
            Some(left) => TcpStream::connect_timeout(addr, if i + 1 == addrs.len() { left } else { (left / 2).max(Duration::from_millis(10)) }),
            None => TcpStream::connect(addr),
        };
        match attempt {
            Ok(s) => {
                s.set_nodelay(details.config.no_delay())?;
                return Ok(s);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(match last {
        Some(e) if !matches!(e.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) => e.into(),
        _ => ureq::Error::Timeout(details.timeout.reason),
    })
}

/// A socket whose waits for input end after `idle` without bytes, or when the thread's
/// interrupt says so; ureq's own deadline for the phase still applies. The waits are `peek`s,
/// so one that times out takes nothing from the socket (after a read times out, Windows leaves a
/// socket's state undefined, bytes possibly lost).
struct Watched {
    stream: TcpStream,
    buffers: LazyBuffers,
    idle: Duration,
}

impl std::fmt::Debug for Watched {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watched").field("peer", &self.stream.peer_addr().ok()).finish()
    }
}

/// A wait that ended without bytes (or was interrupted by a signal): try again.
fn no_bytes_yet(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted)
}

impl Transport for Watched {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.stream.set_write_timeout(timeout.not_zero().map(|d| *d))?;
        match self.stream.write_all(&self.buffers.output()[..amount]) {
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => Err(ureq::Error::Timeout(timeout.reason)),
            r => Ok(r?),
        }
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        let started = Instant::now();
        loop {
            let left = match timeout.after {
                UreqDuration::Exact(d) => d.saturating_sub(started.elapsed()),
                UreqDuration::NotHappening => POLL,
            };
            if left.is_zero() {
                return Err(ureq::Error::Timeout(timeout.reason));
            }
            self.stream.set_read_timeout(Some(left.min(POLL)))?;
            match self.stream.peek(&mut [0u8; 1]) {
                Ok(_) => break,
                Err(e) if no_bytes_yet(&e) => {}
                Err(e) => return Err(e.into()),
            }
            if INTERRUPT.with(|i| i.borrow().as_ref().is_some_and(|f| f())) {
                return Err(io::Error::other("request no longer wanted").into());
            }
            if started.elapsed() >= self.idle {
                return Err(io::Error::new(io::ErrorKind::TimedOut, format!("no data for {} s", self.idle.as_secs_f32())).into());
            }
        }
        // Bytes are there, or the end: this read doesn't wait.
        let n = self.stream.read(self.buffers.input_append_buf())?;
        self.buffers.input_appended(n);
        Ok(n > 0)
    }

    fn is_open(&mut self) -> bool {
        // A pooled connection with bytes waiting (or closed) is done with.
        if self.stream.set_nonblocking(true).is_err() {
            return false;
        }
        let idle = matches!(self.stream.peek(&mut [0u8; 1]), Err(e) if e.kind() == io::ErrorKind::WouldBlock);
        self.stream.set_nonblocking(false).is_ok() && idle
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
