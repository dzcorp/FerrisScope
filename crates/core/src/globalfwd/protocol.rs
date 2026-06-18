//! Wire protocol between the app (`ferrisscope-app`, unprivileged client) and
//! the privileged helper (`ferrisscope-helper`, root/admin server).
//!
//! Framing is a 4-byte big-endian length prefix followed by a JSON-encoded
//! [`Request`] or [`Response`]. The message set is a **closed enum** — the
//! helper executes nothing outside it, which is the core of the privilege
//! boundary: there is no "run this command" variant. Hosts apply is
//! *declarative* (the client always sends the full desired set), so the helper
//! never has to reason about deltas and re-applying is idempotent.

use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Hard cap on a single framed message (1 MiB). A namespace's worth of host
/// entries is a few KiB; anything near this is malformed or hostile.
pub const MAX_FRAME: usize = 1024 * 1024;

/// First message after connect: the client proves it knows the one-time token
/// the app generated and passed to the helper at spawn. The helper rejects any
/// other first message and closes the socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Handshake {
    pub token: String,
    /// Protocol version; bump on breaking wire changes.
    pub version: u32,
}

pub const PROTOCOL_VERSION: u32 = 1;

/// One hosts-file row to apply: an IP and the names resolving to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostEntry {
    pub ip: Ipv4Addr,
    pub hostnames: Vec<String>,
}

/// Client → helper commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// Liveness check.
    Ping,
    /// Bring up a loopback alias for `ip` (no-op on Linux, which loops the whole
    /// `/8`; ifconfig/netsh on macOS/Windows). Must be in `127.0.0.0/8`.
    AddLoopback { ip: Ipv4Addr },
    /// Tear down a previously-added loopback alias. Idempotent.
    DelLoopback { ip: Ipv4Addr },
    /// Bind a TCP listener on `ip:port` (a loopback address) and hand the
    /// listening socket back to the app via SCM_RIGHTS. This is how the app
    /// forwards **privileged** service ports (<1024) on Linux, where an
    /// unprivileged process can't bind them — the elevated helper binds and
    /// passes the fd, keeping the privilege boundary here. The reply is **not** a
    /// framed [`Response`]: on success the helper sends a 1-byte status plus the
    /// fd (one `sendmsg`); on failure a 1-byte status with no fd. See
    /// `ferrisscope-fdpass-ext`.
    BindListener { ip: Ipv4Addr, port: u16 },
    /// Replace the managed hosts block with exactly `entries` (declarative).
    HostsApply { entries: Vec<HostEntry> },
    /// Remove the managed hosts block entirely.
    HostsRemove,
    /// Crash recovery: strip the managed block and drop every loopback alias it
    /// referenced. Returns the addresses purged.
    PurgeStale,
    /// Ask the helper to tear down all state and exit.
    Shutdown,
}

/// Helper → client replies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    /// Generic success.
    Ok,
    /// Reply to `Ping`.
    Pong,
    /// Reply to `PurgeStale`: the loopback addresses removed.
    Purged { ips: Vec<Ipv4Addr> },
    /// Operation failed; `message` is safe to surface in the diagnostics panel.
    Error { message: String },
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("serialize/deserialize failed: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("frame of {0} bytes exceeds MAX_FRAME ({MAX_FRAME})")]
    TooLarge(usize),
    #[error("frame truncated: need {need} bytes, have {have}")]
    Truncated { need: usize, have: usize },
}

/// Encode a message into a length-prefixed frame ready to write to the socket.
pub fn encode<T: Serialize>(msg: &T) -> Result<Vec<u8>, ProtocolError> {
    let payload = serde_json::to_vec(msg)?;
    if payload.len() > MAX_FRAME {
        return Err(ProtocolError::TooLarge(payload.len()));
    }
    let mut buf = Vec::with_capacity(4 + payload.len());
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(&payload);
    Ok(buf)
}

/// Try to decode one framed message from the front of `buf`. On success returns
/// the message and the number of bytes consumed (so the caller can drain its
/// read buffer); returns `Truncated` when the full frame hasn't arrived yet.
pub fn decode<T: for<'de> Deserialize<'de>>(buf: &[u8]) -> Result<(T, usize), ProtocolError> {
    if buf.len() < 4 {
        return Err(ProtocolError::Truncated {
            need: 4,
            have: buf.len(),
        });
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > MAX_FRAME {
        return Err(ProtocolError::TooLarge(len));
    }
    let end = 4 + len;
    if buf.len() < end {
        return Err(ProtocolError::Truncated {
            need: end,
            have: buf.len(),
        });
    }
    let msg = serde_json::from_slice(&buf[4..end])?;
    Ok((msg, end))
}

/// Write one length-prefixed framed message to an async stream. Shared by both
/// the helper (server) and the app (client) so the wire format has one source
/// of truth.
pub async fn write_message<W, T>(w: &mut W, msg: &T) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let frame = encode(msg)?;
    w.write_all(&frame)
        .await
        .map_err(|e| ProtocolError::Serde(serde_json::Error::io(e)))?;
    w.flush()
        .await
        .map_err(|e| ProtocolError::Serde(serde_json::Error::io(e)))?;
    Ok(())
}

/// Read one length-prefixed framed message from an async stream. Returns `None`
/// on a clean EOF before any bytes of the next frame arrive (peer hung up);
/// errors on a partial/oversized frame.
pub async fn read_message<R, T>(r: &mut R) -> Result<Option<T>, ProtocolError>
where
    R: AsyncRead + Unpin,
    T: for<'de> Deserialize<'de>,
{
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        // Clean shutdown: peer closed before sending the next frame.
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(ProtocolError::Serde(serde_json::Error::io(e))),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME {
        return Err(ProtocolError::TooLarge(len));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)
        .await
        .map_err(|e| ProtocolError::Serde(serde_json::Error::io(e)))?;
    let msg = serde_json::from_slice(&payload)?;
    Ok(Some(msg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trips() {
        let msgs = vec![
            Request::Ping,
            Request::AddLoopback {
                ip: Ipv4Addr::new(127, 1, 0, 1),
            },
            Request::DelLoopback {
                ip: Ipv4Addr::new(127, 1, 0, 2),
            },
            Request::HostsApply {
                entries: vec![HostEntry {
                    ip: Ipv4Addr::new(127, 1, 0, 1),
                    hostnames: vec!["api".into(), "api.default".into()],
                }],
            },
            Request::BindListener {
                ip: Ipv4Addr::new(127, 1, 0, 1),
                port: 80,
            },
            Request::HostsRemove,
            Request::PurgeStale,
            Request::Shutdown,
        ];
        for m in msgs {
            let frame = encode(&m).unwrap();
            let (back, consumed): (Request, usize) = decode(&frame).unwrap();
            assert_eq!(back, m);
            assert_eq!(consumed, frame.len());
        }
    }

    #[test]
    fn response_round_trips() {
        for r in [
            Response::Ok,
            Response::Pong,
            Response::Purged {
                ips: vec![Ipv4Addr::new(127, 1, 0, 1)],
            },
            Response::Error {
                message: "boom".into(),
            },
        ] {
            let frame = encode(&r).unwrap();
            let (back, _): (Response, usize) = decode(&frame).unwrap();
            assert_eq!(back, r);
        }
    }

    #[test]
    fn handshake_round_trips() {
        let h = Handshake {
            token: "secret-token".into(),
            version: PROTOCOL_VERSION,
        };
        let frame = encode(&h).unwrap();
        let (back, _): (Handshake, usize) = decode(&frame).unwrap();
        assert_eq!(back, h);
    }

    #[test]
    fn decode_reports_truncation() {
        let frame = encode(&Request::Ping).unwrap();
        // Only the length prefix, no payload yet.
        let err = decode::<Request>(&frame[..4]).unwrap_err();
        assert!(matches!(err, ProtocolError::Truncated { .. }));
        // Not even the full length prefix.
        let err = decode::<Request>(&frame[..2]).unwrap_err();
        assert!(matches!(err, ProtocolError::Truncated { have: 2, .. }));
    }

    #[test]
    fn decode_consumes_exactly_one_of_two_concatenated_frames() {
        let mut stream = encode(&Request::Ping).unwrap();
        let second = encode(&Request::Shutdown).unwrap();
        stream.extend_from_slice(&second);
        let (first, consumed): (Request, usize) = decode(&stream).unwrap();
        assert_eq!(first, Request::Ping);
        // The remaining bytes decode to the second message.
        let (next, _): (Request, usize) = decode(&stream[consumed..]).unwrap();
        assert_eq!(next, Request::Shutdown);
    }

    #[test]
    fn oversized_length_prefix_rejected() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&((MAX_FRAME + 1) as u32).to_be_bytes());
        buf.extend_from_slice(&[0u8; 8]);
        let err = decode::<Request>(&buf).unwrap_err();
        assert!(matches!(err, ProtocolError::TooLarge(_)));
    }

    #[tokio::test]
    async fn async_framing_round_trips_over_duplex() {
        let (mut a, mut b) = tokio::io::duplex(64);
        let sent = vec![
            Request::Ping,
            Request::HostsApply {
                entries: vec![HostEntry {
                    ip: Ipv4Addr::new(127, 1, 0, 1),
                    hostnames: vec!["api".into()],
                }],
            },
            Request::Shutdown,
        ];
        let to_send = sent.clone();
        let writer = tokio::spawn(async move {
            for m in &to_send {
                write_message(&mut a, m).await.unwrap();
            }
            // Drop `a` → EOF for the reader after the last frame.
        });
        let mut got = Vec::new();
        while let Some(m) = read_message::<_, Request>(&mut b).await.unwrap() {
            got.push(m);
        }
        writer.await.unwrap();
        assert_eq!(got, sent);
    }

    #[test]
    fn op_tag_is_stable_on_the_wire() {
        // Guards against accidental rename breaking an already-spawned helper.
        let json = serde_json::to_string(&Request::AddLoopback {
            ip: Ipv4Addr::new(127, 1, 0, 1),
        })
        .unwrap();
        assert!(json.contains("\"op\":\"add_loopback\""));
        assert!(json.contains("\"ip\":\"127.1.0.1\""));

        let bind = serde_json::to_string(&Request::BindListener {
            ip: Ipv4Addr::new(127, 1, 0, 1),
            port: 443,
        })
        .unwrap();
        assert!(bind.contains("\"op\":\"bind_listener\""));
        assert!(bind.contains("\"port\":443"));
    }
}
