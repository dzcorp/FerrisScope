//! File-system watcher for kubeconfig sources.
//!
//! Spawns a single notify watcher across the default kubeconfig path plus
//! every enabled user source (file or folder). Events are debounced to ~300ms
//! and delivered as a single tokio broadcast tick — the consumer re-runs
//! `list_contexts` on each tick.
//!
//! When the source list changes (the user adds/removes/toggles), call
//! [`KubeconfigWatcher::reconfigure`] to swap the watched paths atomically.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tokio::sync::broadcast;

const DEBOUNCE: Duration = Duration::from_millis(300);
const CHANNEL_CAP: usize = 16;

/// One unit broadcast per debounced batch of file events.
#[derive(Debug, Clone, Copy)]
pub struct KubeconfigChanged;

pub struct KubeconfigWatcher {
    debouncer: Mutex<Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>,
    watched: Mutex<Vec<PathBuf>>,
    tx: broadcast::Sender<KubeconfigChanged>,
}

impl KubeconfigWatcher {
    pub fn start() -> std::io::Result<Arc<Self>> {
        let (tx, _rx) = broadcast::channel(CHANNEL_CAP);
        let tx_clone = tx.clone();

        // notify-debouncer-mini delivers events on its own thread; just rebroadcast.
        let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| match res {
            Ok(events) if !events.is_empty() => {
                let _ = tx_clone.send(KubeconfigChanged);
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "kubeconfig watcher error"),
        })
        .map_err(std::io::Error::other)?;

        Ok(Arc::new(Self {
            debouncer: Mutex::new(debouncer),
            watched: Mutex::new(Vec::new()),
            tx,
        }))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<KubeconfigChanged> {
        self.tx.subscribe()
    }

    /// Replace the watched path set with `paths`. Folder paths are watched
    /// non-recursively; file paths are watched on their parent directory
    /// (notify on a single file is unreliable across editors that rename-
    /// then-replace) but events are still narrowed downstream by re-reading.
    pub fn reconfigure(&self, paths: &[PathBuf]) {
        let mut deb = self.debouncer.lock().expect("watcher lock");
        let mut current = self.watched.lock().expect("watched lock");

        // Unwatch everything we previously watched. Errors here mean the path
        // was already gone, which is fine.
        for p in current.drain(..) {
            let _ = deb.watcher().unwatch(&p);
        }

        for p in paths {
            let watch_target: &Path = if p.is_file() {
                match p.parent() {
                    Some(parent) => parent,
                    None => continue,
                }
            } else {
                p.as_path()
            };
            // Same parent might already be watched (multiple files in one dir);
            // skip duplicates.
            if current.iter().any(|existing| existing == watch_target) {
                continue;
            }
            match deb
                .watcher()
                .watch(watch_target, RecursiveMode::NonRecursive)
            {
                Ok(()) => current.push(watch_target.to_path_buf()),
                Err(e) => tracing::warn!(?watch_target, error = %e, "watch failed"),
            }
        }
    }
}
