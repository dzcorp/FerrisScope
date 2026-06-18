//! Create the helper's Windows named-pipe server with an explicit security
//! descriptor so the unprivileged app can connect to it.
//!
//! The helper runs **elevated** (high integrity); the app runs as the normal
//! desktop user (medium integrity). A named pipe created with the default
//! security can deny the medium-IL client when the server is high-IL, and the
//! `ClientOptions::open` connect fails with access-denied. We instead create the
//! first pipe instance with an SD that grants SYSTEM and Administrators full
//! control, the interactive (logged-in) user read+write, and stamps a medium
//! mandatory integrity label so a medium-IL client may write. The per-spawn
//! token still gates the protocol handshake regardless of who can open the pipe.
//!
//! The unsafe Win32 FFI is isolated in this crate (mirrors
//! `ferrisscope-mimalloc-ext`) so the rest of the workspace keeps its
//! `forbid(unsafe_code)` invariant. Non-Windows targets compile this to an empty
//! crate.
#![cfg(windows)]

use std::ffi::c_void;
use std::io;
use std::ptr;

use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;

/// SDDL for the control pipe:
/// - `D:` DACL — `(A;;FA;;;SY)` SYSTEM full, `(A;;FA;;;BA)` builtin Admins full,
///   `(A;;GRGW;;;IU)` interactive users generic read+write (our app process).
/// - `S:` SACL — `(ML;;NW;;;ME)` medium mandatory label with a no-write-up
///   policy, so a medium-IL client can write to this object created by a high-IL
///   process.
const PIPE_SDDL: &str = "D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGW;;;IU)S:(ML;;NW;;;ME)";

/// Create the first instance of the control pipe with the SD above. This is the
/// `ServerOptions::new().first_pipe_instance(true).create(name)` the helper
/// would otherwise call, but with access for the unprivileged app.
pub fn create_first_pipe_instance(name: &str) -> io::Result<NamedPipeServer> {
    let sddl: Vec<u16> = PIPE_SDDL.encode_utf16().chain(std::iter::once(0)).collect();
    let mut psd: *mut c_void = ptr::null_mut();
    // SAFETY: `sddl` is a NUL-terminated UTF-16 string that outlives the call;
    // `psd` is a valid out-pointer. On success the API allocates a self-relative
    // security descriptor (via LocalAlloc) which we free with LocalFree below.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut psd,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut sa = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(std::mem::size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(0),
        lpSecurityDescriptor: psd,
        bInheritHandle: 0,
    };

    // SAFETY: `sa` and the SD it points at outlive this call; tokio copies what
    // it needs during pipe creation. `attrs` points at a valid, fully
    // initialised SECURITY_ATTRIBUTES.
    let result = unsafe {
        ServerOptions::new()
            .first_pipe_instance(true)
            .create_with_security_attributes_raw(name, ptr::addr_of_mut!(sa).cast())
    };

    // SAFETY: `psd` was allocated by the Convert… call (LocalAlloc); LocalFree is
    // its matching deallocator. Safe to call regardless of `result`.
    unsafe {
        LocalFree(psd.cast());
    }

    result
}
