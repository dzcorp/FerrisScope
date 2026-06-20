//! Standalone `ferrisscope-helper` binary — a thin wrapper over the library
//! ([`ferrisscope_helper::run`]). Kept for direct testing / debugging; shipped
//! builds run the same logic embedded in the main `ferrisscope` binary (see
//! `crates/app/src/globalfwd/spawn.rs`).

fn main() {
    // Skip argv[0]; the lib parses the rest.
    if let Err(e) = ferrisscope_helper::run(std::env::args().skip(1)) {
        eprintln!("ferrisscope-helper: {e}");
        std::process::exit(1);
    }
}
