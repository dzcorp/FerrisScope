//! Platform-specific loopback alias management.
//!
//! - **Linux** — no-op. The whole `127.0.0.0/8` is already routed to loopback,
//!   so binding `127.1.0.1:5432` works with no alias and no privilege.
//! - **macOS** — `ifconfig lo0 alias <ip> up` / `ifconfig lo0 -alias <ip>`.
//! - **Windows** — `netsh interface ip add/delete address` on the loopback
//!   pseudo-interface.
//!
//! `add` surfaces failures (the caller reports them); `del` is best-effort —
//! teardown must not abort because an alias was already gone.

use std::net::Ipv4Addr;

use anyhow::Result;

#[cfg(target_os = "linux")]
pub(crate) async fn add(_ip: Ipv4Addr) -> Result<()> {
    // 127.0.0.0/8 loops natively; nothing to alias.
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) async fn del(_ip: Ipv4Addr) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) async fn add(ip: Ipv4Addr) -> Result<()> {
    run("ifconfig", &["lo0", "alias", &ip.to_string(), "up"]).await
}

#[cfg(target_os = "macos")]
pub(crate) async fn del(ip: Ipv4Addr) -> Result<()> {
    // Best-effort: removing an absent alias errors, which we swallow.
    let _ = run("ifconfig", &["lo0", "-alias", &ip.to_string()]).await;
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) async fn add(ip: Ipv4Addr) -> Result<()> {
    run(
        "netsh",
        &[
            "interface",
            "ip",
            "add",
            "address",
            "Loopback Pseudo-Interface 1",
            &ip.to_string(),
            "255.255.255.255",
        ],
    )
    .await
}

#[cfg(target_os = "windows")]
pub(crate) async fn del(ip: Ipv4Addr) -> Result<()> {
    let _ = run(
        "netsh",
        &[
            "interface",
            "ip",
            "delete",
            "address",
            "Loopback Pseudo-Interface 1",
            &ip.to_string(),
        ],
    )
    .await;
    Ok(())
}

// Catch-all for unsupported targets (e.g. *BSD): refuse rather than silently
// "succeed" and then fail to bind.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub(crate) async fn add(_ip: Ipv4Addr) -> Result<()> {
    anyhow::bail!("loopback aliasing is not supported on this platform")
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub(crate) async fn del(_ip: Ipv4Addr) -> Result<()> {
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn run(prog: &str, args: &[&str]) -> Result<()> {
    use anyhow::Context;
    let prog = prog.to_string();
    let argv: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let display = format!("{prog} {argv:?}");

    // Run the helper's only subprocess (`ifconfig` / `netsh`) via **std**, on a
    // blocking thread — NOT `tokio::process`. tokio reaps spawned children
    // through a SIGCHLD-driven reaper; when the helper is launched **elevated**
    // (osascript "with administrator privileges" / pkexec / UAC) the signal mask
    // it inherits can leave SIGCHLD blocked, so that reaper never fires and
    // `.output().await` hangs forever on a child that has already exited — the
    // macOS "`add_loopback` never returns, helper goes unresponsive" wedge.
    // `std::process::Command::output()` `waitpid()`s the specific child directly
    // and does not depend on signal delivery, sidestepping the whole problem.
    // (On Linux this path is never reached — loopback aliasing is a no-op there.)
    let out =
        tokio::task::spawn_blocking(move || std::process::Command::new(&prog).args(&argv).output())
            .await
            .context("subprocess join failed")?
            .with_context(|| format!("failed to spawn {display}"))?;

    if !out.status.success() {
        anyhow::bail!(
            "{display} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}
