//! Async client for the privileged helper. Transport-agnostic: holds a boxed
//! `AsyncRead + AsyncWrite` so the same code drives a Unix socket, a Windows
//! named pipe, or an in-memory duplex (tests). Wire framing is the shared
//! `ferrisscope_core::globalfwd::protocol`.

use std::net::Ipv4Addr;

use anyhow::{anyhow, bail, Result};
use ferrisscope_core::globalfwd::protocol::{
    self, Handshake, HostEntry, Request, Response, PROTOCOL_VERSION,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tracing::warn;

/// Upper bound on one framed helper round-trip. The helper's slowest operation
/// is a loopback-alias `ifconfig` (macOS) or a hosts-file rewrite — both well
/// under a second — so exceeding this means the helper is wedged. Bounding it
/// keeps a stuck helper from hanging the Tauri command (and the UI button)
/// indefinitely. `bind_listener`'s out-of-band fd recv has its own deadline.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// Any bidirectional, sendable byte stream we can run the protocol over.
pub(crate) trait Transport: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Transport for T {}

pub(crate) struct HelperClient {
    stream: Box<dyn Transport>,
    /// Raw fd of the control socket (unix), used only to receive privileged-port
    /// listeners via SCM_RIGHTS in [`Self::bind_listener`]. `None` when the
    /// transport can't pass fds (Windows pipe, in-memory test duplex).
    #[cfg_attr(not(unix), allow(dead_code))]
    ctl_fd: Option<i32>,
    /// Set once a round-trip times out, the helper closes the connection, or the
    /// framed stream desyncs — anything that makes the protocol stream
    /// unusable. Once broken, the manager must drop this client and respawn the
    /// helper rather than keep issuing requests that will hang/error. A benign
    /// `Response::Error` (e.g. validation rejection) does **not** set this — the
    /// stream is still healthy there.
    broken: bool,
}

impl HelperClient {
    /// Perform the handshake over `stream` and, on success, take ownership of it.
    /// `ctl_fd` is the underlying socket's raw fd (unix) for fd passing.
    pub(crate) async fn handshake(
        mut stream: Box<dyn Transport>,
        token: &str,
        ctl_fd: Option<i32>,
    ) -> Result<Self> {
        protocol::write_message(
            &mut stream,
            &Handshake {
                token: token.to_string(),
                version: PROTOCOL_VERSION,
            },
        )
        .await?;
        match protocol::read_message::<_, Response>(&mut stream).await? {
            Some(Response::Ok) => Ok(Self {
                stream,
                ctl_fd,
                broken: false,
            }),
            Some(Response::Error { message }) => bail!("helper handshake rejected: {message}"),
            other => bail!("unexpected handshake reply: {other:?}"),
        }
    }

    /// Whether the protocol stream has become unusable (timeout / closed / IO
    /// error). The manager checks this after each call and, when set, drops the
    /// client so the next operation respawns a fresh helper instead of reusing a
    /// wedged one (which would hang or error forever — the re-toggle bug).
    pub(crate) fn is_broken(&self) -> bool {
        self.broken
    }

    async fn request(&mut self, req: Request) -> Result<Response> {
        let label = req.kind();
        // Hard ceiling on a single round-trip. The helper's slowest op is an
        // `ifconfig` subprocess (macOS loopback alias) — sub-second in practice —
        // so anything past this means the helper wedged (or the framed stream
        // desynced) and we must surface an error rather than hang the UI thread
        // that's awaiting this command forever (a re-toggle would otherwise leave
        // the button spinning with no toast).
        let stream = &mut self.stream;
        let fut = async {
            protocol::write_message(stream, &req).await?;
            protocol::read_message::<_, Response>(stream)
                .await?
                .ok_or_else(|| anyhow!("helper closed the connection"))
        };
        match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
            // Transport IO error or a clean EOF ("closed the connection"): the
            // stream is dead/desynced — poison the client so the manager respawns.
            Ok(Err(e)) => {
                self.broken = true;
                Err(e)
            }
            Ok(ok) => ok,
            Err(_) => {
                self.broken = true;
                warn!(
                    request = label,
                    timeout_secs = REQUEST_TIMEOUT.as_secs(),
                    "helper request timed out; marking helper unresponsive"
                );
                bail!(
                    "helper did not respond to {label} within {}s (it may be unresponsive — \
                     try toggling the forward again, or reconnect the cluster)",
                    REQUEST_TIMEOUT.as_secs()
                )
            }
        }
    }

    fn expect_ok(resp: Response) -> Result<()> {
        match resp {
            Response::Ok => Ok(()),
            Response::Error { message } => bail!("helper error: {message}"),
            other => bail!("unexpected reply: {other:?}"),
        }
    }

    pub(crate) async fn ping(&mut self) -> Result<()> {
        match self.request(Request::Ping).await? {
            Response::Pong => Ok(()),
            other => bail!("unexpected ping reply: {other:?}"),
        }
    }

    pub(crate) async fn add_loopback(&mut self, ip: Ipv4Addr) -> Result<()> {
        let r = self.request(Request::AddLoopback { ip }).await?;
        Self::expect_ok(r)
    }

    pub(crate) async fn del_loopback(&mut self, ip: Ipv4Addr) -> Result<()> {
        let r = self.request(Request::DelLoopback { ip }).await?;
        Self::expect_ok(r)
    }

    /// Ask the helper to bind a privileged loopback listener and pass the
    /// listening socket back via SCM_RIGHTS. Used on Linux for service ports
    /// <1024 the unprivileged app can't bind itself. The reply is out-of-band
    /// (not a framed `Response`): a 1-byte status plus the fd, read with one
    /// `recvmsg` on the control socket — so we poll the non-blocking socket.
    #[cfg(unix)]
    pub(crate) async fn bind_listener(
        &mut self,
        ip: std::net::Ipv4Addr,
        port: u16,
    ) -> Result<std::net::TcpListener> {
        use anyhow::Context;
        use ferrisscope_fdpass_ext::RecvListener;

        let fd = self
            .ctl_fd
            .ok_or_else(|| anyhow!("fd passing unavailable on this transport"))?;
        protocol::write_message(&mut self.stream, &Request::BindListener { ip, port }).await?;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match ferrisscope_fdpass_ext::try_recv_listener(fd) {
                Ok(RecvListener::Listener(l)) => return Ok(l),
                Ok(RecvListener::Failure) => {
                    bail!("helper could not bind {ip}:{port} (see helper log)")
                }
                Ok(RecvListener::WouldBlock) => {
                    if std::time::Instant::now() >= deadline {
                        bail!("timed out waiting for helper to pass the {ip}:{port} listener");
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                Err(e) => return Err(e).context("receiving listener fd from helper"),
            }
        }
    }

    pub(crate) async fn hosts_apply(&mut self, entries: Vec<HostEntry>) -> Result<()> {
        let r = self.request(Request::HostsApply { entries }).await?;
        Self::expect_ok(r)
    }

    pub(crate) async fn purge_stale(&mut self) -> Result<Vec<Ipv4Addr>> {
        match self.request(Request::PurgeStale).await? {
            Response::Purged { ips } => Ok(ips),
            Response::Error { message } => bail!("purge failed: {message}"),
            other => bail!("unexpected purge reply: {other:?}"),
        }
    }

    pub(crate) async fn shutdown(&mut self) -> Result<()> {
        let r = self.request(Request::Shutdown).await?;
        Self::expect_ok(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal in-proc responder mimicking the helper's reply semantics, so we
    /// can verify the client encodes requests and parses replies correctly
    /// without spawning the real (privileged) binary.
    async fn responder(mut io: tokio::io::DuplexStream, token: &'static str) {
        // Handshake.
        let hs: Handshake = protocol::read_message(&mut io).await.unwrap().unwrap();
        let ok = hs.token == token && hs.version == PROTOCOL_VERSION;
        protocol::write_message(
            &mut io,
            &if ok {
                Response::Ok
            } else {
                Response::Error {
                    message: "bad".into(),
                }
            },
        )
        .await
        .unwrap();
        if !ok {
            return;
        }
        // Command loop.
        while let Some(req) = protocol::read_message::<_, Request>(&mut io).await.unwrap() {
            let resp = match req {
                Request::Ping => Response::Pong,
                Request::PurgeStale => Response::Purged {
                    ips: vec![Ipv4Addr::new(127, 1, 0, 5)],
                },
                Request::AddLoopback {
                    ip: Ipv4Addr::BROADCAST,
                } => Response::Error {
                    message: "nope".into(),
                },
                Request::Shutdown => {
                    protocol::write_message(&mut io, &Response::Ok)
                        .await
                        .unwrap();
                    break;
                }
                _ => Response::Ok,
            };
            protocol::write_message(&mut io, &resp).await.unwrap();
        }
    }

    async fn connect(token: &'static str) -> HelperClient {
        let (client_io, server_io) = tokio::io::duplex(4096);
        tokio::spawn(responder(server_io, token));
        HelperClient::handshake(Box::new(client_io), token, None)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn handshake_then_typed_requests() {
        let mut c = connect("secret").await;
        c.ping().await.unwrap();
        c.add_loopback(Ipv4Addr::new(127, 1, 0, 1)).await.unwrap();
        c.del_loopback(Ipv4Addr::new(127, 1, 0, 1)).await.unwrap();
        c.hosts_apply(vec![HostEntry {
            ip: Ipv4Addr::new(127, 1, 0, 1),
            hostnames: vec!["api".into()],
        }])
        .await
        .unwrap();
        assert_eq!(
            c.purge_stale().await.unwrap(),
            vec![Ipv4Addr::new(127, 1, 0, 5)]
        );
        c.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn error_response_becomes_err() {
        let mut c = connect("secret").await;
        let e = c.add_loopback(Ipv4Addr::BROADCAST).await.unwrap_err();
        assert!(e.to_string().contains("nope"), "got: {e}");
        // A *protocol* error (validation rejection) means the stream is still
        // healthy — the client must NOT be poisoned, or one bad input would force
        // a needless helper respawn.
        assert!(
            !c.is_broken(),
            "benign Response::Error must not break the client"
        );
    }

    #[tokio::test]
    async fn closed_connection_poisons_client() {
        // Helper handshakes then dies (drops the socket) without serving requests
        // — the macOS re-toggle wedge looks like this once the timeout/EOF hits.
        let (client_io, server_io) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            let mut io = server_io;
            let hs: Handshake = protocol::read_message(&mut io).await.unwrap().unwrap();
            assert!(hs.token == "secret");
            protocol::write_message(&mut io, &Response::Ok)
                .await
                .unwrap();
            // Drop `io` → the client's next read sees EOF.
        });
        let mut c = HelperClient::handshake(Box::new(client_io), "secret", None)
            .await
            .unwrap();
        assert!(!c.is_broken());
        // The next round-trip fails on the dead transport — whether the write
        // hits a broken pipe or the read sees EOF, both are transport-fatal.
        let _err = c.ping().await.unwrap_err();
        // Poisoned: the manager will see this and respawn a fresh helper.
        assert!(c.is_broken(), "a dead transport must poison the client");
    }

    #[tokio::test]
    async fn bad_token_handshake_fails() {
        let (client_io, server_io) = tokio::io::duplex(4096);
        tokio::spawn(responder(server_io, "secret"));
        let err = match HelperClient::handshake(Box::new(client_io), "WRONG", None).await {
            Ok(_) => panic!("expected handshake to fail"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("rejected"), "got: {err}");
    }

    /// `bind_listener` over a real `UnixStream` pair: a stub "helper" reads the
    /// framed request and passes a listening socket back via SCM_RIGHTS.
    #[cfg(unix)]
    #[tokio::test]
    async fn bind_listener_receives_a_socket() {
        use std::os::fd::AsRawFd;
        use tokio::net::UnixStream;

        let (client_io, mut server_io) = UnixStream::pair().unwrap();
        let server_fd = server_io.as_raw_fd();
        let client_fd = client_io.as_raw_fd();

        // Stub helper: handshake → Ok, then on BindListener bind + pass the fd.
        let srv = tokio::spawn(async move {
            let _hs: Handshake = protocol::read_message(&mut server_io)
                .await
                .unwrap()
                .unwrap();
            protocol::write_message(&mut server_io, &Response::Ok)
                .await
                .unwrap();
            let req: Request = protocol::read_message(&mut server_io)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(req, Request::BindListener { .. }));
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            ferrisscope_fdpass_ext::send_listener(server_fd, &listener).unwrap();
        });

        let mut client = HelperClient::handshake(Box::new(client_io), "t", Some(client_fd))
            .await
            .unwrap();
        let listener = client
            .bind_listener(std::net::Ipv4Addr::LOCALHOST, 0)
            .await
            .unwrap();
        assert_ne!(listener.local_addr().unwrap().port(), 0);
        srv.await.unwrap();
    }
}
