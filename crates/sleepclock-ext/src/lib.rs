//! Total time the machine has spent suspended since boot.
//!
//! Each OS keeps two monotonic clocks that differ only in whether they
//! advance during sleep; their difference is the accumulated sleep time.
//! Both clocks receive the same NTP slew, so wall-clock corrections never
//! show up as sleep.

use std::time::Duration;

/// `None` when the platform exposes no suitable clock pair.
#[must_use]
pub fn asleep_since_boot() -> Option<Duration> {
    imp::asleep_since_boot()
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
mod imp {
    use std::time::Duration;

    #[cfg(any(target_os = "linux", target_os = "android"))]
    const WITH_SLEEP: libc::clockid_t = libc::CLOCK_BOOTTIME;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const WITHOUT_SLEEP: libc::clockid_t = libc::CLOCK_MONOTONIC;

    // Darwin: MONOTONIC_RAW is mach_continuous_time, UPTIME_RAW is
    // mach_absolute_time.
    #[cfg(target_vendor = "apple")]
    const WITH_SLEEP: libc::clockid_t = libc::CLOCK_MONOTONIC_RAW;
    #[cfg(target_vendor = "apple")]
    const WITHOUT_SLEEP: libc::clockid_t = libc::CLOCK_UPTIME_RAW;

    fn read(clock: libc::clockid_t) -> Option<Duration> {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `ts` is a valid, writable timespec; the clock id is a
        // constant supported on this target.
        let rc = unsafe { libc::clock_gettime(clock, &raw mut ts) };
        if rc != 0 {
            return None;
        }
        Some(Duration::new(
            u64::try_from(ts.tv_sec).ok()?,
            u32::try_from(ts.tv_nsec).ok()?,
        ))
    }

    pub(super) fn asleep_since_boot() -> Option<Duration> {
        let without = read(WITHOUT_SLEEP)?;
        let with = read(WITH_SLEEP)?;
        Some(with.saturating_sub(without))
    }
}

#[cfg(windows)]
mod imp {
    use std::time::Duration;
    use windows_sys::Win32::System::WindowsProgramming::{
        QueryInterruptTime, QueryUnbiasedInterruptTime,
    };

    pub(super) fn asleep_since_boot() -> Option<Duration> {
        let mut unbiased: u64 = 0;
        let mut biased: u64 = 0;
        // SAFETY: both functions only write a u64 through the given valid
        // pointer.
        let ok = unsafe { QueryUnbiasedInterruptTime(&raw mut unbiased) };
        if ok == 0 {
            return None;
        }
        unsafe { QueryInterruptTime(&raw mut biased) };
        // Both clocks tick in 100 ns units.
        Some(Duration::from_nanos(
            biased.saturating_sub(unbiased).saturating_mul(100),
        ))
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    windows
)))]
mod imp {
    pub(super) fn asleep_since_boot() -> Option<std::time::Duration> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "linux", target_vendor = "apple", windows))]
    #[test]
    fn reads_a_value_on_supported_platforms() {
        assert!(asleep_since_boot().is_some());
    }

    #[test]
    fn never_decreases_while_awake() {
        let Some(a) = asleep_since_boot() else { return };
        std::thread::sleep(Duration::from_millis(20));
        let b = asleep_since_boot().expect("clock stayed available");
        // Reads of the two clocks are not atomic; allow a sliver of jitter.
        assert!(b + Duration::from_millis(1) >= a, "{a:?} -> {b:?}");
        assert!(
            b.saturating_sub(a) < Duration::from_secs(1),
            "{a:?} -> {b:?}"
        );
    }
}
