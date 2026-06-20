//! Per-connection protocol server: authenticate, then dispatch [`Request`]s.
//!
//! The privilege boundary lives here. Before any work: the client must present
//! the spawn token and matching protocol version. Every mutating request is
//! re-validated against the same rules the pure layer enforces (loopback-only
//! IPs, RFC-1123 hostnames) — the helper trusts nothing on the wire.

use std::net::Ipv4Addr;
use std::sync::Arc;

use ferrisscope_core::globalfwd::hostnames::is_valid_hostname;
use ferrisscope_core::globalfwd::ipalloc::is_loopback_v4;
use ferrisscope_core::globalfwd::protocol::{self, Handshake, Request, Response, PROTOCOL_VERSION};
use tokio::io::{AsyncRead, AsyncWrite};
use tracing::{info, warn};

use crate::state::HelperState;
use crate::{hosts, netalias};

/// Raw control-socket fd used for SCM_RIGHTS fd passing (`BindListener`). On
/// non-unix it's an unused placeholder — fd passing is unix-only and the app
/// never sends `BindListener` on Windows (no privileged-port restriction there).
#[cfg(unix)]
pub(crate) type CtlFd = std::os::fd::RawFd;
#[cfg(not(unix))]
pub(crate) type CtlFd = i32;

/// What the accept loop should do after a connection ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The authenticated control connection ended (app exited/crashed). Tear
    /// down and exit.
    Continue,
    /// The client asked the helper to exit. Tear down and exit.
    Shutdown,
    /// The connection never authenticated (bad/again/EOF handshake). Nothing was
    /// set up; the accept loop should keep waiting for the real app rather than
    /// treat a stray probe as the control connection.
    Rejected,
}

fn err(msg: impl Into<String>) -> Response {
    Response::Error {
        message: msg.into(),
    }
}

/// Serve one client connection to completion. Returns [`Outcome::Shutdown`] if
/// the client asked the helper to exit.
///
/// `ctl_fd` is the raw fd of this connection's socket (unix), used only to pass
/// privileged-port listeners back via SCM_RIGHTS. `None` when the transport
/// can't pass fds (Windows pipe, in-memory test duplex) — `BindListener` then
/// fails gracefully.
pub(crate) async fn serve_connection<S>(
    mut stream: S,
    state: Arc<HelperState>,
    ctl_fd: Option<CtlFd>,
) -> Outcome
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // --- Handshake ---
    // Every pre-auth exit is `Rejected`, not `Continue`: nothing has been set up
    // yet, and the accept loop must keep waiting for the real app rather than
    // letting a stray probe (or a hostile client that fails the handshake)
    // consume the control slot and trip teardown.
    let handshake: Option<Handshake> = match protocol::read_message(&mut stream).await {
        Ok(h) => h,
        Err(e) => {
            warn!(error = %e, "failed to read handshake");
            return Outcome::Rejected;
        }
    };
    let Some(handshake) = handshake else {
        return Outcome::Rejected; // client hung up before handshaking
    };
    if handshake.version != PROTOCOL_VERSION || handshake.token != state.token {
        // Don't reveal which check failed.
        let _ = protocol::write_message(&mut stream, &err("unauthorized")).await;
        warn!("rejected handshake (token/version mismatch)");
        return Outcome::Rejected;
    }
    if protocol::write_message(&mut stream, &Response::Ok)
        .await
        .is_err()
    {
        return Outcome::Rejected;
    }

    // --- Command loop ---
    loop {
        let req: Option<Request> = match protocol::read_message(&mut stream).await {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "read request failed; closing connection");
                return Outcome::Continue;
            }
        };
        let Some(req) = req else {
            return Outcome::Continue; // clean EOF
        };
        // `BindListener`'s reply is an out-of-band SCM_RIGHTS message on the raw
        // socket (not a framed `Response`), so it's handled inline where we have
        // `ctl_fd` rather than going through `handle`.
        if let Request::BindListener { ip, port } = req {
            handle_bind_listener(ctl_fd, ip, port).await;
            continue;
        }
        let (resp, outcome) = handle(&state, req).await;
        if protocol::write_message(&mut stream, &resp).await.is_err() {
            return Outcome::Continue;
        }
        if outcome == Outcome::Shutdown {
            return Outcome::Shutdown;
        }
    }
}

/// Bind a privileged loopback listener and hand its fd to the app over the
/// control socket. Unix only — the elevated helper can bind <1024 where the app
/// can't. Validates the address is loopback before binding. All reply paths go
/// through SCM_RIGHTS (success = status byte + fd, failure = status byte only).
#[cfg(unix)]
async fn handle_bind_listener(ctl_fd: Option<CtlFd>, ip: Ipv4Addr, port: u16) {
    let Some(ctl_fd) = ctl_fd else {
        warn!("BindListener on a transport without fd passing; ignoring");
        return;
    };
    if !is_loopback_v4(ip) {
        warn!(%ip, "refusing to bind non-loopback address");
        let _ = ferrisscope_fdpass_ext::send_failure(ctl_fd);
        return;
    }
    match std::net::TcpListener::bind((ip, port)) {
        Ok(listener) => {
            match ferrisscope_fdpass_ext::send_listener(ctl_fd, &listener) {
                Ok(()) => info!(%ip, port, "bound privileged listener; passed fd to app"),
                Err(e) => warn!(%ip, port, error = %e, "failed to send listener fd"),
            }
            // Drop our copy; the app holds its own dup of the listening socket.
        }
        Err(e) => {
            warn!(%ip, port, error = %e, "failed to bind privileged listener");
            let _ = ferrisscope_fdpass_ext::send_failure(ctl_fd);
        }
    }
}

#[cfg(not(unix))]
#[allow(clippy::unused_async)]
async fn handle_bind_listener(_ctl_fd: Option<CtlFd>, ip: Ipv4Addr, port: u16) {
    // fd passing is unix-only; the app never sends this on Windows.
    warn!(%ip, port, "BindListener is not supported on this platform");
}

async fn handle(state: &Arc<HelperState>, req: Request) -> (Response, Outcome) {
    match req {
        Request::Ping => (Response::Pong, Outcome::Continue),

        Request::AddLoopback { ip } => {
            if !is_loopback_v4(ip) {
                return (
                    err(format!("{ip} is not a loopback address")),
                    Outcome::Continue,
                );
            }
            match netalias::add(ip).await {
                Ok(()) => {
                    state.aliases.lock().await.insert(ip);
                    (Response::Ok, Outcome::Continue)
                }
                Err(e) => (err(e.to_string()), Outcome::Continue),
            }
        }

        Request::DelLoopback { ip } => {
            let _ = netalias::del(ip).await;
            state.aliases.lock().await.remove(&ip);
            (Response::Ok, Outcome::Continue)
        }

        Request::HostsApply { entries } => {
            for e in &entries {
                if !is_loopback_v4(e.ip) {
                    return (err(format!("non-loopback ip {}", e.ip)), Outcome::Continue);
                }
                for h in &e.hostnames {
                    if !is_valid_hostname(h) {
                        return (err(format!("invalid hostname {h:?}")), Outcome::Continue);
                    }
                }
            }
            match hosts::apply(state, entries).await {
                Ok(()) => (Response::Ok, Outcome::Continue),
                Err(e) => (err(e.to_string()), Outcome::Continue),
            }
        }

        Request::HostsRemove => match hosts::remove(state).await {
            Ok(()) => (Response::Ok, Outcome::Continue),
            Err(e) => (err(e.to_string()), Outcome::Continue),
        },

        Request::PurgeStale => match hosts::purge_stale(state).await {
            Ok(ips) => {
                let mut aliases = state.aliases.lock().await;
                for ip in &ips {
                    let _ = netalias::del(*ip).await;
                    aliases.remove(ip);
                }
                (Response::Purged { ips }, Outcome::Continue)
            }
            Err(e) => (err(e.to_string()), Outcome::Continue),
        },

        Request::Shutdown => {
            teardown(state).await;
            (Response::Ok, Outcome::Shutdown)
        }

        // Intercepted in the command loop (out-of-band fd reply); never reaches
        // here. Defensive arm keeps the match exhaustive.
        Request::BindListener { .. } => (
            err("bind_listener must be handled inline"),
            Outcome::Continue,
        ),
    }
}

/// Drop every alias we created and strip our hosts block. Best-effort; logs but
/// never panics. Called on `Shutdown` and on parent-death.
pub(crate) async fn teardown(state: &Arc<HelperState>) {
    let ips: Vec<_> = {
        let mut aliases = state.aliases.lock().await;
        aliases.drain().collect()
    };
    for ip in ips {
        let _ = netalias::del(ip).await;
    }
    if let Err(e) = hosts::remove(state).await {
        warn!(error = %e, "hosts cleanup on teardown failed");
    } else {
        info!("helper teardown complete");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrisscope_core::globalfwd::protocol::HostEntry;
    use std::net::Ipv4Addr;
    use std::path::Path;
    use tokio::fs;

    async fn state_in(dir: &Path, token: &str) -> Arc<HelperState> {
        let hosts = dir.join("hosts");
        fs::write(&hosts, "127.0.0.1\tlocalhost\n").await.unwrap();
        Arc::new(HelperState::new(
            token.into(),
            hosts,
            dir.join("hosts.backup"),
        ))
    }

    /// Drive a server end with a scripted client over an in-memory duplex.
    async fn with_client<F, Fut>(state: Arc<HelperState>, client: F) -> Outcome
    where
        F: FnOnce(tokio::io::DuplexStream) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let (server_io, client_io) = tokio::io::duplex(4096);
        // In-memory duplex has no socket fd → BindListener fd passing is N/A here.
        let srv = tokio::spawn(async move { serve_connection(server_io, state, None).await });
        client(client_io).await;
        srv.await.unwrap()
    }

    async fn send(io: &mut tokio::io::DuplexStream, req: &Request) -> Response {
        protocol::write_message(io, req).await.unwrap();
        protocol::read_message::<_, Response>(io)
            .await
            .unwrap()
            .unwrap()
    }

    async fn handshake_ok(io: &mut tokio::io::DuplexStream, token: &str) -> Response {
        protocol::write_message(
            io,
            &Handshake {
                token: token.into(),
                version: PROTOCOL_VERSION,
            },
        )
        .await
        .unwrap();
        protocol::read_message::<_, Response>(io)
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn good_handshake_then_ping_pong_and_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path(), "secret").await;
        let outcome = with_client(st, |mut io| async move {
            assert_eq!(handshake_ok(&mut io, "secret").await, Response::Ok);
            assert_eq!(send(&mut io, &Request::Ping).await, Response::Pong);
            assert_eq!(send(&mut io, &Request::Shutdown).await, Response::Ok);
        })
        .await;
        assert_eq!(outcome, Outcome::Shutdown);
    }

    #[tokio::test]
    async fn bad_token_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path(), "secret").await;
        // A bad handshake must surface an error AND yield `Rejected`, so the
        // accept loop keeps waiting for the real app instead of exiting.
        let outcome = with_client(st, |mut io| async move {
            let resp = handshake_ok(&mut io, "WRONG").await;
            assert!(matches!(resp, Response::Error { .. }));
        })
        .await;
        assert_eq!(outcome, Outcome::Rejected);
    }

    #[tokio::test]
    async fn wrong_version_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path(), "secret").await;
        let outcome = with_client(st, |mut io| async move {
            protocol::write_message(
                &mut io,
                &Handshake {
                    token: "secret".into(),
                    version: PROTOCOL_VERSION + 99,
                },
            )
            .await
            .unwrap();
            let resp = protocol::read_message::<_, Response>(&mut io)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(resp, Response::Error { .. }));
        })
        .await;
        assert_eq!(outcome, Outcome::Rejected);
    }

    #[tokio::test]
    async fn hangup_before_handshake_is_rejected_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path(), "secret").await;
        // Client connects and immediately drops without handshaking (a probe).
        // Must be `Rejected` so the helper keeps listening for the real app.
        let outcome = with_client(st, |io| async move {
            drop(io);
        })
        .await;
        assert_eq!(outcome, Outcome::Rejected);
    }

    #[tokio::test]
    async fn hosts_apply_writes_block_and_validates_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path(), "t").await;
        let hosts_path = st.hosts_path.clone();
        let hosts_path_in = hosts_path.clone();
        with_client(st, |mut io| async move {
            handshake_ok(&mut io, "t").await;
            // Valid apply.
            let ok = send(
                &mut io,
                &Request::HostsApply {
                    entries: vec![HostEntry {
                        ip: Ipv4Addr::new(127, 1, 0, 1),
                        hostnames: vec!["api".into(), "api.default".into()],
                    }],
                },
            )
            .await;
            assert_eq!(ok, Response::Ok);
            // Block is live mid-session (before Shutdown's teardown strips it).
            let mid = fs::read_to_string(&hosts_path_in).await.unwrap();
            assert!(mid.contains("127.1.0.1\tapi api.default"));
            // Non-loopback IP rejected.
            let bad_ip = send(
                &mut io,
                &Request::HostsApply {
                    entries: vec![HostEntry {
                        ip: Ipv4Addr::new(10, 0, 0, 1),
                        hostnames: vec!["api".into()],
                    }],
                },
            )
            .await;
            assert!(matches!(bad_ip, Response::Error { .. }));
            // Bogus hostname rejected.
            let bad_host = send(
                &mut io,
                &Request::HostsApply {
                    entries: vec![HostEntry {
                        ip: Ipv4Addr::new(127, 1, 0, 1),
                        hostnames: vec!["EVIL HOST".into()],
                    }],
                },
            )
            .await;
            assert!(matches!(bad_host, Response::Error { .. }));
            assert_eq!(send(&mut io, &Request::Shutdown).await, Response::Ok);
        })
        .await;

        // Shutdown ran teardown → block stripped, foreign line kept.
        let content = fs::read_to_string(&hosts_path).await.unwrap();
        assert!(content.contains("127.0.0.1\tlocalhost"));
        use ferrisscope_core::globalfwd::hostsfile;
        assert!(!hostsfile::has_block(&content));
    }

    /// End-to-end `BindListener` over a real `UnixStream` pair: the server binds
    /// a privileged-style loopback listener and passes the fd; the client adopts
    /// it and it accepts connections.
    #[cfg(unix)]
    #[tokio::test]
    async fn bind_listener_passes_a_usable_socket() {
        use std::os::fd::AsRawFd;
        use tokio::net::UnixStream;

        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path(), "t").await;
        let (server_io, client_io) = UnixStream::pair().unwrap();
        let server_fd = server_io.as_raw_fd();
        let client_fd = client_io.as_raw_fd();

        let srv =
            tokio::spawn(async move { serve_connection(server_io, st, Some(server_fd)).await });

        // Drive the client: handshake, then request a bind on an ephemeral port
        // (port 0 — a real privileged port would need root in the test).
        let mut io = client_io;
        protocol::write_message(
            &mut io,
            &Handshake {
                token: "t".into(),
                version: PROTOCOL_VERSION,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            protocol::read_message::<_, Response>(&mut io)
                .await
                .unwrap()
                .unwrap(),
            Response::Ok
        );
        protocol::write_message(
            &mut io,
            &Request::BindListener {
                ip: Ipv4Addr::LOCALHOST,
                port: 0,
            },
        )
        .await
        .unwrap();

        // Receive the passed fd (poll the non-blocking socket).
        let listener = loop {
            match ferrisscope_fdpass_ext::try_recv_listener(client_fd).unwrap() {
                ferrisscope_fdpass_ext::RecvListener::WouldBlock => {
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                }
                ferrisscope_fdpass_ext::RecvListener::Listener(l) => break l,
                ferrisscope_fdpass_ext::RecvListener::Failure => panic!("bind failed"),
            }
        };
        let port = listener.local_addr().unwrap().port();
        assert_ne!(port, 0, "listener should be bound to a real port");
        // It accepts: connect from a thread and accept on the passed socket.
        listener.set_nonblocking(false).unwrap();
        let h = std::thread::spawn(move || {
            std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        });
        let accepted = listener.accept();
        assert!(accepted.is_ok());
        h.join().unwrap();

        // Close cleanly so the server loop ends.
        drop(io);
        let _ = srv.await.unwrap();
    }

    #[tokio::test]
    async fn add_loopback_rejects_non_loopback() {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(dir.path(), "t").await;
        with_client(st, |mut io| async move {
            handshake_ok(&mut io, "t").await;
            let resp = send(
                &mut io,
                &Request::AddLoopback {
                    ip: Ipv4Addr::new(8, 8, 8, 8),
                },
            )
            .await;
            assert!(matches!(resp, Response::Error { .. }));
        })
        .await;
    }
}
