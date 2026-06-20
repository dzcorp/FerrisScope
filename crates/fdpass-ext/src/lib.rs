//! Pass a listening socket between processes over a connected Unix
//! `SOCK_STREAM` socket using `SCM_RIGHTS`.
//!
//! Used by global (DNS) port-forwarding on **unix** (Linux *and* macOS): both
//! reserve ports <1024 for root, so the elevated helper binds a privileged
//! loopback listener — which an unprivileged process can't — and hands the
//! listening socket to the app. The privilege boundary stays at the helper: no
//! `setcap`, no persistent capability, no binary edits.
//!
//! Wire shape for one exchange (after the app has sent a framed
//! `Request::BindListener`): the helper replies with a single `sendmsg` carrying
//! one status byte of regular data plus, on success, the listener fd as an
//! `SCM_RIGHTS` control message. The app reads it with one `recvmsg`.
//!
//! The unsafe libc FFI is isolated here (mirrors `ferrisscope-mimalloc-ext` /
//! `-winpipe-ext`) so the rest of the workspace keeps `forbid(unsafe_code)`.
//! Non-unix targets compile this to an empty crate.
#![cfg(unix)]

use std::io;
use std::net::TcpListener;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};

const STATUS_OK: u8 = 1;
const STATUS_ERR: u8 = 0;

/// Outcome of one non-blocking [`try_recv_listener`] attempt.
pub enum RecvListener {
    /// No message has arrived yet (`EAGAIN`/`EWOULDBLOCK`) — caller should retry.
    WouldBlock,
    /// The peer reported it could not bind (status byte `0`, no fd).
    Failure,
    /// The listening socket was received and adopted.
    Listener(TcpListener),
}

/// A `cmsghdr`-aligned scratch buffer big enough for one fd. Aligning to
/// `cmsghdr` (not `u8`) is required — `CMSG_FIRSTHDR`/`CMSG_DATA` assume it.
#[repr(C)]
union CmsgBuf {
    _align: libc::cmsghdr,
    bytes: [u8; 64],
}

impl CmsgBuf {
    fn zeroed() -> Self {
        // SAFETY: an all-zero byte array is a valid inhabitant of the union.
        unsafe { std::mem::zeroed() }
    }
}

/// Send `listener`'s fd to the connected peer with a 1-byte OK status. The
/// caller retains ownership of `listener` and should drop it afterwards — the
/// peer receives its own dup of the underlying file.
pub fn send_listener(socket: RawFd, listener: &TcpListener) -> io::Result<()> {
    send_msg(socket, STATUS_OK, Some(listener.as_raw_fd()))
}

/// Tell the peer the bind failed: a 1-byte error status, no fd.
pub fn send_failure(socket: RawFd) -> io::Result<()> {
    send_msg(socket, STATUS_ERR, None)
}

fn send_msg(socket: RawFd, status: u8, fd: Option<RawFd>) -> io::Result<()> {
    let mut status_byte = [status];
    let mut iov = libc::iovec {
        iov_base: status_byte.as_mut_ptr().cast(),
        iov_len: 1,
    };
    let mut cmsg = CmsgBuf::zeroed();

    // SAFETY: we build a msghdr referencing `iov` and (when sending an fd) the
    // aligned `cmsg` buffer, both of which outlive the `sendmsg` call. The
    // control message is laid out exactly as the CMSG_* macros require.
    let n = unsafe {
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = std::ptr::addr_of_mut!(iov);
        msg.msg_iovlen = 1;

        if let Some(fd) = fd {
            let space = libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) as usize;
            debug_assert!(space <= 64);
            msg.msg_control = std::ptr::addr_of_mut!(cmsg.bytes).cast();
            msg.msg_controllen = space as _;
            let cmsgp = libc::CMSG_FIRSTHDR(&msg);
            (*cmsgp).cmsg_level = libc::SOL_SOCKET;
            (*cmsgp).cmsg_type = libc::SCM_RIGHTS;
            (*cmsgp).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<RawFd>() as u32) as _;
            std::ptr::copy_nonoverlapping(
                std::ptr::addr_of!(fd),
                libc::CMSG_DATA(cmsgp).cast::<RawFd>(),
                1,
            );
        }

        libc::sendmsg(socket, std::ptr::addr_of!(msg), 0)
    };

    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// One non-blocking `recvmsg`. The socket is expected to be non-blocking (a
/// tokio socket is), so [`RecvListener::WouldBlock`] is returned when nothing
/// has arrived yet.
pub fn try_recv_listener(socket: RawFd) -> io::Result<RecvListener> {
    let mut status_byte = [0u8; 1];
    let mut iov = libc::iovec {
        iov_base: status_byte.as_mut_ptr().cast(),
        iov_len: 1,
    };
    let mut cmsg = CmsgBuf::zeroed();

    // Every fd received in this message. A well-behaved sender passes exactly
    // one, but we drain *all* of them (across every SCM_RIGHTS cmsg and every
    // entry in each cmsg's fd array) so a buggy or hostile peer can't make us
    // leak descriptors — anything we don't adopt is closed below.
    let mut fds: Vec<RawFd> = Vec::new();

    // SAFETY: msghdr references `iov` and the aligned `cmsg` buffer; both outlive
    // the call. We only read the control buffer via the CMSG_* macros afterward.
    let (n, truncated) = unsafe {
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = std::ptr::addr_of_mut!(iov);
        msg.msg_iovlen = 1;
        msg.msg_control = std::ptr::addr_of_mut!(cmsg.bytes).cast();
        msg.msg_controllen = 64;

        let n = libc::recvmsg(socket, std::ptr::addr_of_mut!(msg), 0);
        if n < 0 {
            let e = io::Error::last_os_error();
            return if e.kind() == io::ErrorKind::WouldBlock {
                Ok(RecvListener::WouldBlock)
            } else {
                Err(e)
            };
        }

        let mut cmsgp = libc::CMSG_FIRSTHDR(&msg);
        while !cmsgp.is_null() {
            if (*cmsgp).cmsg_level == libc::SOL_SOCKET && (*cmsgp).cmsg_type == libc::SCM_RIGHTS {
                let data = libc::CMSG_DATA(cmsgp);
                // Bytes of fd payload = cmsg_len minus the header/alignment up to
                // CMSG_DATA. Integer-divide so a truncated trailing fragment is
                // never read as a whole fd.
                let payload = (*cmsgp).cmsg_len as usize - (data as usize - cmsgp as usize);
                let count = payload / std::mem::size_of::<RawFd>();
                for i in 0..count {
                    let mut got: RawFd = -1;
                    std::ptr::copy_nonoverlapping(
                        data.cast::<RawFd>().add(i),
                        std::ptr::addr_of_mut!(got),
                        1,
                    );
                    fds.push(got);
                }
            }
            cmsgp = libc::CMSG_NXTHDR(std::ptr::addr_of!(msg), cmsgp);
        }
        (n, msg.msg_flags & libc::MSG_CTRUNC != 0)
    };

    // Close every fd we received but won't adopt. `keep` (if any) is excluded.
    let close_all_but = |keep: Option<RawFd>| {
        for &fd in &fds {
            if Some(fd) != keep {
                // SAFETY: each fd was transferred to us and is owned by this
                // process; nothing else has adopted it.
                unsafe { libc::close(fd) };
            }
        }
    };

    if n == 0 {
        close_all_but(None);
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "helper closed the connection during fd passing",
        ));
    }

    match (status_byte[0], truncated, fds.first().copied()) {
        (STATUS_OK, false, Some(fd)) => {
            // Adopt the first fd; close any extras a misbehaving sender attached.
            close_all_but(Some(fd));
            // SAFETY: `fd` was just transferred to us via SCM_RIGHTS and is owned
            // by this process; adopt it as a TcpListener.
            Ok(RecvListener::Listener(unsafe {
                TcpListener::from_raw_fd(fd)
            }))
        }
        (STATUS_OK, false, None) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ok status but no fd was passed",
        )),
        _ => {
            // Failure status, or a truncated control message: don't trust the
            // transfer. Close everything we received and report failure.
            close_all_but(None);
            Ok(RecvListener::Failure)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A connected, non-blocking AF_UNIX SOCK_STREAM pair.
    fn socketpair() -> (RawFd, RawFd) {
        let mut fds = [0 as RawFd; 2];
        let rc = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
        assert_eq!(rc, 0, "socketpair: {}", io::Error::last_os_error());
        for fd in fds {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            assert_eq!(
                unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) },
                0
            );
        }
        (fds[0], fds[1])
    }

    fn recv_blocking(sock: RawFd) -> RecvListener {
        for _ in 0..1000 {
            match try_recv_listener(sock).unwrap() {
                RecvListener::WouldBlock => std::thread::sleep(std::time::Duration::from_millis(1)),
                other => return other,
            }
        }
        panic!("never received");
    }

    #[test]
    fn round_trips_a_real_listening_socket() {
        let (a, b) = socketpair();
        // Bind an ephemeral listener and pass it across.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        send_listener(a, &listener).unwrap();
        drop(listener); // sender drops its copy; receiver has the dup

        match recv_blocking(b) {
            RecvListener::Listener(got) => {
                // The received fd is the same listening socket (same local port)
                // and is independently usable.
                assert_eq!(got.local_addr().unwrap().port(), port);
                // It should accept connections.
                let _conn = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                got.set_nonblocking(true).unwrap();
                let accepted = got.accept();
                assert!(accepted.is_ok(), "accept on passed socket failed");
            }
            _ => panic!("expected a listener"),
        }
        unsafe {
            libc::close(a);
            libc::close(b);
        }
    }

    #[test]
    fn failure_is_reported_without_fd() {
        let (a, b) = socketpair();
        send_failure(a).unwrap();
        assert!(matches!(recv_blocking(b), RecvListener::Failure));
        unsafe {
            libc::close(a);
            libc::close(b);
        }
    }

    #[test]
    fn would_block_when_nothing_sent() {
        let (a, b) = socketpair();
        // `a` stays open so the peer isn't closed — a closed peer would turn the
        // recv from EAGAIN (WouldBlock) into EOF.
        assert!(matches!(
            try_recv_listener(b).unwrap(),
            RecvListener::WouldBlock
        ));
        unsafe {
            libc::close(a);
            libc::close(b);
        }
    }
}
