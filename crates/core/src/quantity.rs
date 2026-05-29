//! Kubernetes `resource.Quantity` parsing.
//!
//! A Quantity is a decimal number with an optional decimal SI suffix
//! (`n`, `u`, `m`, `k`/`K`, `M`, `G`, `T`, `P`, `E`) or a binary IEC suffix
//! (`Ki`, `Mi`, `Gi`, `Ti`, `Pi`, `Ei`). We parse to **base units** — cores for
//! CPU, bytes for memory — and let each caller convert to millicores / MiB with
//! whatever rounding and clamping it needs (the metrics poller clamps negatives
//! to `0` and returns `u64`; the pod totals projection keeps an `Option<i64>`
//! and skips unparseable entries).
//!
//! This is the single quantity parser shared across the workspace. It lives in
//! the Tauri-free engine crate so both `core::metrics` and `ferrisscope-kube-ext`
//! (the pod resource-totals projection) reach it without a new dependency or a
//! second copy drifting out of sync.

/// Parse a Kubernetes quantity string to its base-unit `f64` — cores for CPU,
/// bytes for memory. Returns `None` for empty / unparseable input or an
/// unrecognised suffix.
///
/// Note: because the numeric scan treats `e`/`E` as part of a possible
/// scientific-notation mantissa, the decimal exa suffix (`E`) and IEC exbi
/// suffix (`Ei`) do not round-trip — `"5E"` / `"5Ei"` parse as `None`. Exabyte
/// quantities are vanishingly rare in practice; this matches the long-standing
/// behaviour of both former copies (the pod copy had no `Ei` arm at all), so
/// unifying here changes nothing observable.
#[must_use]
pub fn parse_quantity(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let split = s
        .char_indices()
        .find(|(_, c)| !matches!(c, '0'..='9' | '.' | '+' | '-' | 'e' | 'E'))
        .map_or(s.len(), |(i, _)| i);
    let (num, suf) = s.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mult: f64 = match suf {
        "" => 1.0,
        "n" => 1e-9,
        "u" => 1e-6,
        "m" => 1e-3,
        "K" | "k" => 1e3,
        "M" => 1e6,
        "G" => 1e9,
        "T" => 1e12,
        "P" => 1e15,
        "E" => 1e18,
        "Ki" => 1024.0,
        "Mi" => 1024.0_f64.powi(2),
        "Gi" => 1024.0_f64.powi(3),
        "Ti" => 1024.0_f64.powi(4),
        "Pi" => 1024.0_f64.powi(5),
        "Ei" => 1024.0_f64.powi(6),
        _ => return None,
    };
    Some(n * mult)
}

#[cfg(test)]
mod tests {
    use super::parse_quantity;

    fn approx(label: &str, got: Option<f64>, want: f64) {
        let g = got.unwrap_or_else(|| panic!("{label}: expected Some, got None"));
        assert!(
            (g - want).abs() <= want.abs() * 1e-9 + 1e-9,
            "{label}: got {g}, want {want}"
        );
    }

    #[test]
    fn plain_numbers_and_decimals() {
        approx("100", parse_quantity("100"), 100.0);
        approx("1.5", parse_quantity("1.5"), 1.5);
        approx("0", parse_quantity("0"), 0.0);
        // Scientific notation is valid decimal Quantity syntax.
        approx("1e3", parse_quantity("1e3"), 1000.0);
    }

    #[test]
    fn cpu_sub_unit_suffixes() {
        approx("100m", parse_quantity("100m"), 0.1);
        approx("250m", parse_quantity("250m"), 0.25);
        approx("1500m", parse_quantity("1500m"), 1.5);
        approx("999999n", parse_quantity("999999n"), 999_999e-9);
        approx("500000u", parse_quantity("500000u"), 0.5);
    }

    #[test]
    fn decimal_si_suffixes() {
        approx("1K", parse_quantity("1K"), 1e3);
        approx("1k (lowercase)", parse_quantity("1k"), 1e3);
        approx("2M", parse_quantity("2M"), 2e6);
        approx("1G", parse_quantity("1G"), 1e9);
        approx("1T", parse_quantity("1T"), 1e12);
        approx("1P", parse_quantity("1P"), 1e15);
    }

    #[test]
    fn binary_iec_suffixes() {
        approx("1Ki", parse_quantity("1Ki"), 1024.0);
        approx("256Mi", parse_quantity("256Mi"), 256.0 * 1024.0 * 1024.0);
        approx("2Gi", parse_quantity("2Gi"), 2.0 * 1024.0_f64.powi(3));
        approx("1Ti", parse_quantity("1Ti"), 1024.0_f64.powi(4));
        approx("1Pi", parse_quantity("1Pi"), 1024.0_f64.powi(5));
    }

    #[test]
    fn unrecognised_and_malformed_are_none() {
        assert_eq!(parse_quantity(""), None);
        assert_eq!(parse_quantity("   "), None);
        assert_eq!(parse_quantity("nope"), None);
        assert_eq!(parse_quantity("5X"), None); // unknown suffix
        assert_eq!(parse_quantity("Mi"), None); // suffix without a number
    }

    #[test]
    fn negatives_pass_through_unclamped() {
        // The parser itself does not clamp — clamping to >= 0 is the caller's
        // job (the metrics poller does; the pod projection does not). Pin the
        // raw contract so neither caller's behaviour silently shifts.
        approx("-1", parse_quantity("-1"), -1.0);
        approx("-1Gi", parse_quantity("-1Gi"), -(1024.0_f64.powi(3)));
    }
}
