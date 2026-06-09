//! Poison-tolerant locking.
//!
//! `std::sync::Mutex` poisons when a holder panics, and the next
//! `.lock().expect(…)` turns that one panic into a second, app-killing
//! panic on an unrelated thread. For our locks the guarded data stays
//! structurally valid (caches, forwarder maps, ring buffers) — a possibly
//! half-applied update is strictly better than crashing the whole desktop
//! app — so we recover the guard and log loudly instead.

use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T> {
    /// Like [`Mutex::lock`], but on poison recovers the guard instead of
    /// panicking. The original panic that poisoned the lock has already
    /// been reported by the panic hook; this logs the recovery site.
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    #[track_caller]
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        match self.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let loc = std::panic::Location::caller();
                tracing::error!(
                    "recovered poisoned mutex at {}:{} — a previous holder panicked",
                    loc.file(),
                    loc.line()
                );
                poisoned.into_inner()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LockExt;
    use std::sync::{Arc, Mutex};

    #[test]
    fn returns_guard_on_clean_lock() {
        let m = Mutex::new(7);
        assert_eq!(*m.lock_recover(), 7);
    }

    #[test]
    fn recovers_data_after_poison() {
        let m = Arc::new(Mutex::new(vec![1, 2]));
        let m2 = Arc::clone(&m);
        // Poison the mutex: panic while holding the guard.
        let _ = std::thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.lock().is_err(), "mutex should be poisoned");

        let mut guard = m.lock_recover();
        guard.push(3);
        assert_eq!(*guard, vec![1, 2, 3]);
    }
}
