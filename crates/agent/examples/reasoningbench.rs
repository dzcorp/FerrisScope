//! Reasoning spec / lowering costs against the real models.dev cache, and the
//! lists the settings page would show for each provider.
//!
//! `cargo run --release -p ferrisscope-agent --example reasoningbench`
//! (cache dir from `MODELS_DEV_DIR`, default `~/.config/ferrisscope/agent`)

use std::time::Instant;

use ferrisscope_agent::config::ProviderReasoning;
use ferrisscope_agent::provider::catalogue;
use ferrisscope_agent::provider::reasoning::{lower, spec};
use ferrisscope_agent::ProviderKind;

#[tokio::main]
async fn main() {
    let dir = std::env::var("MODELS_DEV_DIR").unwrap_or_else(|_| {
        format!(
            "{}/.config/ferrisscope/agent",
            std::env::var("HOME").unwrap_or_default()
        )
    });
    let t = Instant::now();
    catalogue::load_from_disk(dir.into()).await;
    println!("catalogue load + parse: {:?}", t.elapsed());

    println!("\nprovider-level specs (what Settings → AI lists per provider):");
    for kind in ProviderKind::all() {
        let s = spec(*kind, None);
        println!(
            "  {:<18} efforts={:<44} budget={:<22} toggle={} catalogue={}",
            format!("{kind:?}"),
            s.efforts.join(","),
            s.budget
                .as_ref()
                .map_or("-".to_string(), |b| format!("{}..{:?}", b.min, b.max)),
            s.toggle,
            s.from_catalogue
        );
    }

    let iters = 200;
    let t = Instant::now();
    for _ in 0..iters {
        for kind in ProviderKind::all() {
            std::hint::black_box(spec(*kind, None));
        }
    }
    println!(
        "\nspec(kind, None) for all {} providers: {:?} per sweep ({iters} sweeps)",
        ProviderKind::all().len(),
        t.elapsed() / iters
    );

    let t = Instant::now();
    for _ in 0..iters * 100 {
        std::hint::black_box(spec(ProviderKind::Anthropic, Some("claude-sonnet-5-5")));
    }
    println!(
        "spec(Anthropic, Some(model)): {:?} per call",
        t.elapsed() / (iters * 100)
    );

    let choice = ProviderReasoning {
        effort: Some("high".into()),
        budget_tokens: None,
    };
    let t = Instant::now();
    for _ in 0..iters * 100 {
        std::hint::black_box(lower(
            ProviderKind::Anthropic,
            "claude-sonnet-5-5",
            &choice,
            false,
        ));
    }
    println!(
        "lower(Anthropic, model, high): {:?} per call",
        t.elapsed() / (iters * 100)
    );

    println!("\nper-model examples:");
    for (kind, model) in [
        (ProviderKind::Anthropic, "claude-sonnet-5-5"),
        (ProviderKind::Anthropic, "claude-haiku-4-5"),
        (ProviderKind::OpenAI, "gpt-5.4"),
        (ProviderKind::Google, "gemini-3.5-flash"),
        (ProviderKind::Deepseek, "deepseek-reasoner"),
        (ProviderKind::OpencodeZen, "kimi-k3"),
    ] {
        let s = spec(kind, Some(model));
        println!(
            "  {kind:?}/{model}: efforts={:?} budget={:?} toggle={}",
            s.efforts,
            s.budget.map(|b| (b.min, b.max)),
            s.toggle
        );
    }
}
