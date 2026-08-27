//! Kubernetes-flavoured cron parsing and next-fire calculation.
//!
//! The CronJob controller uses robfig/cron in its 5-field ("standard") mode
//! plus the `@yearly`/`@monthly`/… macros, so that is exactly what we accept
//! here. Deliberately hand-rolled rather than pulled from a crate: the crates
//! that exist either default to 6/7-field (seconds-first) expressions, which
//! silently mis-parse every real CronJob, or drag in a parser generator.
//!
//! Everything is total — a schedule we cannot parse yields `None` and the UI
//! shows a dash. Never panic on operator-authored strings.

use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

/// A parsed 5-field cron expression, stored as bitsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSchedule {
    /// Bit `n` set ⇒ minute `n` matches. `0..=59`.
    minutes: u64,
    /// Bit `n` set ⇒ hour `n` matches. `0..=23`.
    hours: u32,
    /// Bit `n` set ⇒ day-of-month `n` matches. `1..=31`.
    doms: u32,
    /// Bit `n` set ⇒ month `n` matches. `1..=12`.
    months: u16,
    /// Bit `n` set ⇒ weekday `n` matches, Sunday = 0.
    dows: u8,
    /// Whether the day-of-month field narrows anything — see [`is_restricted`].
    /// Together with `dow_restricted` this selects cron's OR rule; see
    /// [`Self::matches_date`].
    dom_restricted: bool,
    dow_restricted: bool,
}

const MINUTE_ALL: u64 = (1u64 << 60) - 1;
const HOUR_ALL: u32 = (1u32 << 24) - 1;
const DOM_ALL: u32 = ((1u32 << 31) - 1) << 1;
const MONTH_ALL: u16 = ((1u16 << 12) - 1) << 1;
const DOW_ALL: u8 = (1u8 << 7) - 1;

/// How far ahead [`CronSchedule::next_after`] will look before giving up. A
/// schedule like `0 0 30 2 *` (Feb 30th) never fires; bound the search rather
/// than spin.
const MAX_LOOKAHEAD_DAYS: u32 = 5 * 366;

const MONTH_NAMES: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const DOW_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

impl CronSchedule {
    /// Parse a CronJob `spec.schedule`. Returns `None` for anything the
    /// controller would also reject, and for `@every <duration>` — which is
    /// an interval, not a calendar rule, and has no fixed next-fire we can
    /// derive without knowing the controller's own start time.
    #[must_use]
    pub fn parse(expr: &str) -> Option<Self> {
        let expr = expr.trim();
        if expr.is_empty() {
            return None;
        }
        if let Some(macro_name) = expr.strip_prefix('@') {
            let expanded = match macro_name.to_ascii_lowercase().as_str() {
                "yearly" | "annually" => "0 0 1 1 *",
                "monthly" => "0 0 1 * *",
                "weekly" => "0 0 * * 0",
                "daily" | "midnight" => "0 0 * * *",
                "hourly" => "0 * * * *",
                _ => return None,
            };
            return Self::parse_fields(expanded);
        }
        Self::parse_fields(expr)
    }

    fn parse_fields(expr: &str) -> Option<Self> {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() != 5 {
            return None;
        }
        let minutes = parse_field(fields[0], 0, 59, None)? as u64;
        let hours = u32::try_from(parse_field(fields[1], 0, 23, None)?).ok()?;
        let doms = u32::try_from(parse_field(fields[2], 1, 31, None)?).ok()?;
        let months = u16::try_from(parse_field(fields[3], 1, 12, Some(&MONTH_NAMES))?).ok()?;
        let dows = u8::try_from(normalize_dow(parse_field(
            fields[4],
            0,
            7,
            Some(&DOW_NAMES),
        )?))
        .ok()?;

        Some(Self {
            minutes,
            hours,
            doms,
            months,
            dows,
            dom_restricted: is_restricted(fields[2]),
            dow_restricted: is_restricted(fields[4]),
        })
    }

    /// Cron's day rule: when *both* day-of-month and day-of-week are
    /// restricted the fields are OR'd, not AND'd (so `0 0 1 * MON` fires on
    /// the 1st *and* every Monday). If only one is restricted, AND is what
    /// the controller does — including when the other side is `*/2`, which
    /// counts as unrestricted.
    fn matches_date(&self, date: NaiveDate) -> bool {
        if self.months & (1u16 << date.month()) == 0 {
            return false;
        }
        let dom_hit = self.doms & (1u32 << date.day()) != 0;
        let dow_hit = self.dows & (1u8 << (date.weekday().num_days_from_sunday() as u8)) != 0;
        if self.dom_restricted && self.dow_restricted {
            dom_hit || dow_hit
        } else {
            dom_hit && dow_hit
        }
    }

    /// First fire strictly after `after`, in the same (naive) wall-clock frame
    /// as `after`. `None` when the schedule cannot fire within
    /// [`MAX_LOOKAHEAD_DAYS`].
    #[must_use]
    pub fn next_after(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        // Cron has minute resolution: the next candidate is the minute after
        // the one `after` falls in, regardless of its seconds.
        let start = after.with_second(0)?.with_nanosecond(0)? + chrono::Duration::minutes(1);
        let mut date = start.date();
        let mut from_minute = start.hour() * 60 + start.minute();

        for _ in 0..MAX_LOOKAHEAD_DAYS {
            if self.matches_date(date) {
                for m in from_minute..24 * 60 {
                    let (h, min) = (m / 60, m % 60);
                    if self.hours & (1u32 << h) != 0 && self.minutes & (1u64 << min) != 0 {
                        return date.and_hms_opt(h, min, 0);
                    }
                }
            }
            date = date.succ_opt()?;
            from_minute = 0;
        }
        None
    }
}

/// Next fire of `schedule` after `now`, as an RFC 3339 UTC instant.
///
/// `time_zone` is the CronJob's `spec.timeZone`. When absent the controller
/// evaluates the schedule in the kube-controller-manager's own zone; we assume
/// UTC, which is what it is in every managed and default-manifest deployment.
/// An IANA name we cannot resolve yields `None` rather than a plausible-looking
/// wrong instant.
#[must_use]
pub fn next_run_rfc3339(
    schedule: &str,
    time_zone: Option<&str>,
    now: chrono::DateTime<Utc>,
) -> Option<String> {
    let parsed = CronSchedule::parse(schedule)?;
    let Some(tz_name) = time_zone else {
        return parsed
            .next_after(now.naive_utc())
            .map(|dt| Utc.from_utc_datetime(&dt).to_rfc3339());
    };
    let tz: Tz = tz_name.parse().ok()?;
    let local_now = now.with_timezone(&tz).naive_local();
    let next_local = parsed.next_after(local_now)?;
    let resolved = resolve_local(tz, next_local)?;
    Some(resolved.with_timezone(&Utc).to_rfc3339())
}

/// Turn a wall-clock time in `tz` into an instant.
///
/// Two DST edges have to be handled explicitly. A fall-back *overlap* names
/// two instants — we take the earlier, which is the one the controller reaches
/// first. A spring-forward *gap* names none; Go's `time.Date` (which the
/// controller is built on) normalises such a time forward past the jump, so we
/// probe ahead until the clock exists again rather than dropping the run.
fn resolve_local(tz: Tz, naive: NaiveDateTime) -> Option<chrono::DateTime<Tz>> {
    if let Some(dt) = tz.from_local_datetime(&naive).earliest() {
        return Some(dt);
    }
    // No DST shift in the tz database exceeds a couple of hours.
    (1..=180).find_map(|m| {
        tz.from_local_datetime(&(naive + chrono::Duration::minutes(m)))
            .earliest()
    })
}

/// Parse one cron field into a bitset over `[min, max]`. `names` supplies the
/// three-letter aliases valid for this field, indexed from `min`.
fn parse_field(field: &str, min: u32, max: u32, names: Option<&[&str]>) -> Option<u128> {
    let mut bits: u128 = 0;
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }
        let (range, step) = match part.split_once('/') {
            // Clamp to the field's own width. A step wider than the range can
            // only ever set the first bit, and leaving it unclamped overflows
            // the `v += step` walk below on an operator-authored `5/4294967295`.
            Some((r, s)) => (
                r,
                s.parse::<u32>()
                    .ok()
                    .filter(|s| *s > 0)
                    .map(|s| s.min(max.saturating_sub(min) + 1))?,
            ),
            None => (part, 1),
        };
        let (lo, hi) = if range == "*" || range == "?" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (
                parse_value(a, min, max, names)?,
                parse_value(b, min, max, names)?,
            )
        } else {
            let v = parse_value(range, min, max, names)?;
            // `5/2` means "from 5 to the end of the range, every 2" — the
            // bare-value-with-step form robfig accepts.
            if step > 1 {
                (v, max)
            } else {
                (v, v)
            }
        };
        if lo > hi {
            return None;
        }
        let mut v = lo;
        while v <= hi {
            bits |= 1u128 << v;
            v += step;
        }
    }
    if bits == 0 {
        return None;
    }
    Some(bits)
}

/// Whether a day-of-month / day-of-week field narrows anything.
///
/// Cron ORs the two day fields only when *both* are restricted. robfig — which
/// the CronJob controller is built on — decides that per comma-part on whether
/// the part before any `/` is `*` or `?`, so `*/2` counts as unrestricted even
/// though it selects half the days. Matching that matters: reading `*/2` as
/// restricted turns `0 0 */2 * MON` into an OR and shows a next-fire time
/// earlier than the cluster will actually run.
fn is_restricted(field: &str) -> bool {
    !field.split(',').any(|part| {
        let range = part.trim().split_once('/').map_or(part.trim(), |(r, _)| r);
        range == "*" || range == "?"
    })
}

fn parse_value(raw: &str, min: u32, max: u32, names: Option<&[&str]>) -> Option<u32> {
    let raw = raw.trim();
    if let Ok(n) = raw.parse::<u32>() {
        return (n >= min && n <= max).then_some(n);
    }
    let names = names?;
    let lower = raw.to_ascii_lowercase();
    names
        .iter()
        .position(|n| *n == lower)
        .and_then(|i| u32::try_from(i).ok())
        .map(|i| i + min)
}

/// Cron accepts both `0` and `7` for Sunday. Fold bit 7 onto bit 0 so the
/// weekday lookup can index `num_days_from_sunday()` directly.
fn normalize_dow(bits: u128) -> u128 {
    if bits & (1u128 << 7) != 0 {
        (bits & !(1u128 << 7)) | 1
    } else {
        bits
    }
}

/// Sanity floor for the constants above — they encode field domains that must
/// stay in sync with the bit widths.
const _: () = {
    assert!(MINUTE_ALL.count_ones() == 60);
    assert!(HOUR_ALL.count_ones() == 24);
    assert!(DOM_ALL.count_ones() == 31);
    assert!(MONTH_ALL.count_ones() == 12);
    assert!(DOW_ALL.count_ones() == 7);
};

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").expect("valid fixture timestamp")
    }

    fn next(expr: &str, from: &str) -> Option<String> {
        CronSchedule::parse(expr)?
            .next_after(at(from))
            .map(|d| d.format("%Y-%m-%dT%H:%M:%S").to_string())
    }

    #[test]
    fn every_minute() {
        assert_eq!(
            next("* * * * *", "2026-08-27T10:15:30"),
            Some("2026-08-27T10:16:00".to_owned())
        );
    }

    /// Strictly-after: standing exactly on a fire time must yield the *next*
    /// one, not the current one, or a "next run" readout freezes on the tick
    /// it already ran.
    #[test]
    fn is_strictly_after() {
        assert_eq!(
            next("0 * * * *", "2026-08-27T10:00:00"),
            Some("2026-08-27T11:00:00".to_owned())
        );
    }

    #[test]
    fn step_and_list() {
        assert_eq!(
            next("*/15 * * * *", "2026-08-27T10:16:00"),
            Some("2026-08-27T10:30:00".to_owned())
        );
        assert_eq!(
            next("5,35 * * * *", "2026-08-27T10:10:00"),
            Some("2026-08-27T10:35:00".to_owned())
        );
    }

    #[test]
    fn ranges_with_step() {
        assert_eq!(
            next("0 9-17/4 * * *", "2026-08-27T10:00:00"),
            Some("2026-08-27T13:00:00".to_owned())
        );
    }

    /// `5/2` is "from 5 onwards, every 2" — the bare-value-with-step form.
    #[test]
    fn bare_value_with_step_runs_to_end_of_range() {
        assert_eq!(
            next("0 5/6 * * *", "2026-08-27T06:00:00"),
            Some("2026-08-27T11:00:00".to_owned())
        );
    }

    #[test]
    fn month_and_day_names() {
        assert_eq!(
            next("0 0 * mar mon", "2026-01-05T00:00:00"),
            Some("2026-03-02T00:00:00".to_owned())
        );
    }

    /// The rule everyone gets wrong: with both DOM and DOW restricted, cron
    /// ORs them.
    #[test]
    fn dom_and_dow_both_restricted_is_or() {
        // 2026-09-01 is a Tuesday; the schedule must fire on it (DOM hit)
        // as well as on the following Monday (DOW hit).
        assert_eq!(
            next("0 0 1 * mon", "2026-08-31T12:00:00"),
            Some("2026-09-01T00:00:00".to_owned())
        );
        assert_eq!(
            next("0 0 1 * mon", "2026-09-01T00:00:00"),
            Some("2026-09-07T00:00:00".to_owned())
        );
    }

    /// Only one side restricted ⇒ plain AND, so a `*` DOM must not drag in
    /// every day of the month.
    #[test]
    fn dow_only_is_and() {
        assert_eq!(
            next("0 0 * * fri", "2026-08-27T00:00:00"),
            Some("2026-08-28T00:00:00".to_owned())
        );
    }

    #[test]
    fn sunday_accepts_both_zero_and_seven() {
        assert_eq!(
            next("0 0 * * 7", "2026-08-27T00:00:00"),
            next("0 0 * * 0", "2026-08-27T00:00:00"),
        );
    }

    #[test]
    fn macros_expand() {
        assert_eq!(
            next("@daily", "2026-08-27T10:00:00"),
            Some("2026-08-28T00:00:00".to_owned())
        );
        assert_eq!(
            next("@yearly", "2026-08-27T10:00:00"),
            Some("2027-01-01T00:00:00".to_owned())
        );
        assert_eq!(
            CronSchedule::parse("@weekly"),
            CronSchedule::parse("0 0 * * 0")
        );
    }

    /// Crossing a leap day must land on the 29th, not skip the year.
    #[test]
    fn leap_day() {
        assert_eq!(
            next("0 0 29 2 *", "2027-03-01T00:00:00"),
            Some("2028-02-29T00:00:00".to_owned())
        );
    }

    /// An unsatisfiable schedule terminates instead of spinning.
    #[test]
    fn impossible_date_gives_up() {
        assert_eq!(next("0 0 30 2 *", "2026-01-01T00:00:00"), None);
    }

    /// robfig treats a field whose range part is `*` or `?` as unrestricted
    /// even with a step, so `*/2` must AND rather than OR. Reading it as
    /// restricted shows a next fire earlier than the cluster will run.
    #[test]
    fn stepped_star_is_not_a_restriction() {
        // 2026-09-01 is a Tuesday. With AND, the first match is the first
        // Monday that also falls on an odd day-of-month.
        let anded = next("0 0 */2 * mon", "2026-09-01T00:00:00").expect("parses");
        let date = &anded[..10];
        // Must be a Monday, not merely an odd-numbered day.
        let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").expect("date");
        assert_eq!(
            parsed.weekday(),
            chrono::Weekday::Mon,
            "{anded} is not a Monday — the day fields were OR'd"
        );
    }

    /// `?` is robfig's synonym for `*` in the day fields. Rejecting it would
    /// blank the next-run readout for a schedule the cluster accepts.
    #[test]
    fn question_mark_reads_as_star() {
        assert_eq!(
            next("0 0 ? * fri", "2026-08-27T00:00:00"),
            next("0 0 * * fri", "2026-08-27T00:00:00"),
        );
    }

    /// An absurd step must clamp, not overflow the bit walk. Unclamped this
    /// panics in debug and wraps in release, which would show a wrong next
    /// fire as fact.
    #[test]
    fn absurd_step_clamps_instead_of_overflowing() {
        assert_eq!(
            next("5/4294967295 * * * *", "2026-08-27T10:00:00"),
            Some("2026-08-27T10:05:00".to_owned())
        );
        assert!(CronSchedule::parse("* * * * */4294967295").is_some());
    }

    #[test]
    fn rejects_malformed() {
        for bad in [
            "",
            "* * * *",
            "* * * * * *",
            "60 * * * *",
            "* 24 * * *",
            "0 0 0 * *",
            "0 0 * 13 *",
            "0 0 * * 8",
            "*/0 * * * *",
            "5-1 * * * *",
            "@every 1h",
            "@nope",
            "a * * * *",
            "0 0 * jann *",
            "1,, * * * *",
        ] {
            assert!(
                CronSchedule::parse(bad).is_none(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn next_run_rfc3339_without_timezone_is_utc() {
        let now = "2026-08-27T10:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .expect("fixture");
        assert_eq!(
            next_run_rfc3339("30 10 * * *", None, now).as_deref(),
            Some("2026-08-27T10:30:00+00:00")
        );
    }

    /// A zoned schedule must convert back to UTC — the whole reason we carry
    /// a tz database. 09:00 Warsaw in August is 07:00Z (CEST, UTC+2).
    #[test]
    fn next_run_rfc3339_honours_time_zone() {
        let now = "2026-08-27T00:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .expect("fixture");
        assert_eq!(
            next_run_rfc3339("0 9 * * *", Some("Europe/Warsaw"), now).as_deref(),
            Some("2026-08-27T07:00:00+00:00")
        );
    }

    /// An unresolvable zone must yield nothing rather than silently falling
    /// back to UTC and showing an hours-off time as fact.
    #[test]
    fn next_run_rfc3339_rejects_unknown_zone() {
        let now = "2026-08-27T00:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .expect("fixture");
        assert!(next_run_rfc3339("0 9 * * *", Some("Mars/Olympus"), now).is_none());
    }

    /// Spring-forward: 02:30 does not exist on 2026-03-29 in Warsaw, so the
    /// resolver must still produce an instant instead of dropping the run.
    #[test]
    fn next_run_rfc3339_survives_dst_gap() {
        let now = "2026-03-28T12:00:00Z"
            .parse::<chrono::DateTime<Utc>>()
            .expect("fixture");
        assert!(next_run_rfc3339("30 2 * * *", Some("Europe/Warsaw"), now).is_some());
    }
}
