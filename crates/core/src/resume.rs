//! System suspend/resume detection.
//!
//! tokio timers and `Instant` stop while the machine sleeps on Linux and
//! macOS, so nothing time-based notices a long suspend. We poll the OS's
//! accumulated sleep time instead and report each jump.

use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::{interval, MissedTickBehavior};

pub const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Shorter suspends leave connections intact often enough that a forced
/// reconnect would cost more than it saves.
pub const MIN_SLEEP: Duration = Duration::from_secs(10);

/// Turns cumulative sleep-time samples into per-suspend durations.
#[derive(Debug)]
pub struct SleepTracker {
    last: Duration,
    min_sleep: Duration,
}

impl SleepTracker {
    #[must_use]
    pub fn new(baseline: Duration, min_sleep: Duration) -> Self {
        Self {
            last: baseline,
            min_sleep,
        }
    }

    /// Returns how long the machine slept since the previous sample, if at
    /// least `min_sleep`. Sub-threshold sleeps still advance the baseline so
    /// they never add up into a false positive.
    pub fn observe(&mut self, asleep_total: Duration) -> Option<Duration> {
        let slept = asleep_total.saturating_sub(self.last);
        self.last = self.last.max(asleep_total);
        (slept >= self.min_sleep).then_some(slept)
    }
}

/// Spawn the detector. `None` when the platform can't measure sleep time.
pub fn spawn<F>(on_resume: F) -> Option<JoinHandle<()>>
where
    F: FnMut(Duration) + Send + 'static,
{
    let baseline = ferrisscope_sleepclock_ext::asleep_since_boot()?;
    Some(spawn_with(
        baseline,
        ferrisscope_sleepclock_ext::asleep_since_boot,
        POLL_INTERVAL,
        MIN_SLEEP,
        on_resume,
    ))
}

fn spawn_with<S, F>(
    baseline: Duration,
    mut sample: S,
    poll: Duration,
    min_sleep: Duration,
    mut on_resume: F,
) -> JoinHandle<()>
where
    S: FnMut() -> Option<Duration> + Send + 'static,
    F: FnMut(Duration) + Send + 'static,
{
    tokio::spawn(async move {
        let mut tracker = SleepTracker::new(baseline, min_sleep);
        let mut tick = interval(poll);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let Some(total) = sample() else { continue };
            if let Some(slept) = tracker.observe(total) {
                tracing::info!(slept_secs = slept.as_secs(), "system resumed from sleep");
                on_resume(slept);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const MIN: Duration = Duration::from_secs(10);

    #[test]
    fn reports_a_long_sleep_once() {
        let mut t = SleepTracker::new(Duration::from_secs(100), MIN);
        assert_eq!(t.observe(Duration::from_secs(100)), None);
        assert_eq!(
            t.observe(Duration::from_secs(1900)),
            Some(Duration::from_mins(30))
        );
        assert_eq!(t.observe(Duration::from_secs(1900)), None);
    }

    #[test]
    fn short_sleeps_never_accumulate_into_a_resume() {
        let mut t = SleepTracker::new(Duration::ZERO, MIN);
        for i in 1..=10 {
            assert_eq!(t.observe(Duration::from_secs(i * 5)), None);
        }
    }

    #[test]
    fn threshold_is_inclusive() {
        let mut t = SleepTracker::new(Duration::ZERO, MIN);
        assert_eq!(t.observe(MIN), Some(MIN));
    }

    #[test]
    fn a_backwards_sample_is_ignored_without_moving_the_baseline() {
        let mut t = SleepTracker::new(Duration::from_secs(50), MIN);
        assert_eq!(t.observe(Duration::from_secs(49)), None);
        assert_eq!(
            t.observe(Duration::from_mins(1)),
            Some(Duration::from_secs(10))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn spawned_detector_fires_on_a_sleep_jump() {
        let samples = Arc::new(Mutex::new(vec![
            Some(Duration::from_hours(1)),
            None,
            Some(Duration::ZERO),
            Some(Duration::ZERO),
        ]));
        let fired = Arc::new(Mutex::new(Vec::new()));
        let task = spawn_with(
            Duration::ZERO,
            {
                let samples = samples.clone();
                move || samples.lock().unwrap().pop().flatten()
            },
            POLL_INTERVAL,
            MIN,
            {
                let fired = fired.clone();
                move |d| fired.lock().unwrap().push(d)
            },
        );
        tokio::time::sleep(POLL_INTERVAL * 5).await;
        task.abort();
        assert_eq!(*fired.lock().unwrap(), vec![Duration::from_hours(1)]);
    }
}
