//! `agent::prompt` — see `agent/mod.rs` for the split rationale.

use ferrisscope_agent::classify_tool;
use ferrisscope_agent::mcp::ToolCategory;

use crate::agent_native;
use crate::state::AppState;

use super::ViewContextWire;

const SYSTEM_PROMPT_BASELINE: &str = "\
You are FerrisScope's Kubernetes operator assistant. You help the user \
understand and operate their Kubernetes cluster. Prefer Server-Side Apply \
for any change.\n\
\n\
Format every response as Markdown using only the following constructs:\n\
- short paragraphs for prose; one blank line between paragraphs\n\
- `inline code` for resource names, fields, identifiers, and short shell snippets\n\
- fenced code blocks ``` with a language tag for YAML, multi-line shell, or log excerpts \
(```yaml, ```sh, ```json, ```text)\n\
- bullet (`-`) or numbered (`1.`) lists for steps and option enumerations; one item per line, no nesting\n\
- task list items (`- [ ]` / `- [x]`) when summarising a plan or checklist\n\
- **bold** for important caveats or destructive-action warnings; ~~strikethrough~~ for \
deprecated/avoid options when contrasting with a recommendation\n\
- bare http(s) URLs are auto-linkified, so you can paste a docs URL inline; use \
`[label](url)` only when the label adds value\n\
- in-app navigation links via `ferrisscope://` URLs — clicking them drives the \
FerrisScope UI instead of opening a browser. Use them whenever you reference a \
specific resource so the operator can jump to it in one click. Forms:\n\
  - `ferrisscope://resource/<kind>/<namespace>/<name>` opens the detail panel for \
    a namespaced resource (`<kind>` matches the Kubernetes Kind like `Pod`, \
    `Deployment`, `ConfigMap`, or our internal id like `pods`, `helm_releases`)\n\
  - `ferrisscope://resource/<kind>/-/<name>` is the same for cluster-scoped \
    resources (Node, Namespace, ClusterRole, etc.) — use the literal `-` for \
    namespace\n\
  - `ferrisscope://kind/<kind>` switches the rail to that kind's list view\n\
  - URL-encode names that contain spaces or special characters\n\
  - emit the link as raw Markdown — `[label](ferrisscope://...)` — and \
    NEVER wrap the whole link in backticks. Wrapping it (e.g. \
    `` `[mypod](ferrisscope://...)` ``) turns the entire thing into \
    inline code and the operator sees literal `[mypod](url)` text. \
    Inline code is for raw identifiers like `mypod`, NOT for links. \
    Correct in a table cell: `| [mypod](ferrisscope://resource/Pod/default/mypod) | Running |` — \
    do not put backticks around it. If you also want monospaced label \
    text, put the backticks INSIDE the label: \
    `[`mypod`](ferrisscope://resource/Pod/default/mypod)`.\n\
- horizontal rule (`---` on its own line) to separate clearly distinct sections within one reply\n\
- `##` or `###` headings only when an answer has multiple distinct sections; never use `#`\n\
- GitHub-flavoured pipe tables for tabular data: header row, then a `| --- | --- |` \
separator (use `:---`, `:---:`, `---:` to set per-column alignment), then data rows. \
Always include the separator row — without it the table will render as plain text.\n\
\n\
Do not use blockquotes, images, HTML, or nested lists — the chat renderer \
ignores them. Be concise: skip filler text, lead with the answer, and when \
a tool result already shows the data, cite the relevant lines instead of \
restating the whole output.";

/// Render the "you are connected to context X" block injected into the
/// system prompt at the start of every turn. Reads the active cluster id
/// off the chat's `ChatClusterCtx` and looks up its `ContextInfo` from the
/// operator's registered sources. If the active context drifted (operator
/// removed the source after the chat opened, or the id was never resolvable
/// to begin with) we still emit a block citing the raw id — better stale
/// than silent. Returns "" when there are no sources at all (nothing
/// useful to say).
pub(crate) async fn build_cluster_context_block(
    cluster: &agent_native::ChatClusterRef,
    app_state: &AppState,
) -> String {
    let active_id = cluster.active().await;
    let origin_id = cluster.origin().to_string();
    let switched = active_id != origin_id;

    let sources = app_state.sources.lock().await;
    let contexts = ferrisscope_core::kubeconfig::list_contexts(&sources).unwrap_or_default();
    drop(sources);
    let active = contexts.iter().find(|c| c.id == active_id);
    let origin = contexts.iter().find(|c| c.id == origin_id);

    let mut out = String::from("## Current Kubernetes context\n\n");
    if let Some(c) = active {
        let ns = c
            .namespace
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("(none)");
        let _ = std::fmt::Write::write_fmt(
            &mut out,
            format_args!(
                "Active context: `{}` (cluster `{}`, default namespace `{}`, source group `{}`).\n",
                c.name, c.cluster, ns, c.group
            ),
        );
    } else {
        let _ = std::fmt::Write::write_fmt(
            &mut out,
            format_args!(
                "Active cluster id: `{active_id}` (not currently resolvable in any source).\n"
            ),
        );
    }
    if switched {
        if let Some(c) = origin {
            let _ = std::fmt::Write::write_fmt(
                &mut out,
                format_args!(
                    "This chat opened against `{}` (cluster `{}`); you switched contexts via \
                     `fs_configuration_use_context`. Switch again or back at any time.\n",
                    c.name, c.cluster
                ),
            );
        } else {
            let _ = std::fmt::Write::write_fmt(
                &mut out,
                format_args!(
                    "This chat opened against cluster id `{origin_id}` and was switched mid-session.\n"
                ),
            );
        }
    } else {
        out.push_str(
            "Use `fs_configuration_use_context` to retarget every subsequent native tool call \
             at a different registered context. The operator's UI selection is independent.\n",
        );
    }
    out
}

/// Cap on rendered selected rows. Above this we render a summary line so
/// a multi-select of 500 pods doesn't blow up the system prompt.
const VIEW_CONTEXT_SELECTED_CAP: usize = 10;

/// Assemble the full system prompt: baseline + optional cluster block +
/// optional view-context block + operator's free-form override. Each
/// component is appended with a single blank-line separator when
/// non-empty so empties don't leave stray whitespace.
pub(crate) fn assemble_system_prompt(
    cluster_block: &str,
    view_block: &str,
    override_extra: Option<&str>,
) -> String {
    let mut out = SYSTEM_PROMPT_BASELINE.to_string();
    if !cluster_block.is_empty() {
        out.push_str("\n\n");
        out.push_str(cluster_block);
    }
    if !view_block.is_empty() {
        out.push_str("\n\n");
        out.push_str(view_block);
    }
    if let Some(extra) = override_extra.filter(|s| !s.is_empty()) {
        out.push_str("\n\n");
        out.push_str(extra);
    }
    out
}

/// Render the optional "what the operator is viewing" block. Returns ""
/// when there's nothing useful to say (no view payload, or all fields
/// empty). The block is informational — the LLM is told explicitly it
/// may ignore it if the request is unrelated.
pub(crate) async fn build_view_context_block(
    view: Option<&ViewContextWire>,
    chat_active_cluster: &str,
    app_state: &AppState,
) -> String {
    use std::fmt::Write as _;
    let Some(v) = view else {
        return String::new();
    };
    let nothing = v.cluster_id.as_deref().unwrap_or("").is_empty()
        && v.kind_id.as_deref().unwrap_or("").is_empty()
        && v.kind_label.as_deref().unwrap_or("").is_empty()
        && v.namespaces.is_empty()
        && v.selected.is_empty();
    if nothing {
        return String::new();
    }

    let mut out = String::from("## What the operator is viewing\n\n");
    out.push_str(
        "Informational only. This describes the FerrisScope UI surface the operator has \
         open right now; use it to resolve vague references like \"this\", \"here\", or \
         \"fix this\". If the operator's request is clearly unrelated to what they're \
         viewing, ignore this block.\n\n",
    );

    if let Some(ui_cluster) = v.cluster_id.as_deref().filter(|s| !s.is_empty()) {
        if ui_cluster != chat_active_cluster {
            let sources = app_state.sources.lock().await;
            let contexts =
                ferrisscope_core::kubeconfig::list_contexts(&sources).unwrap_or_default();
            drop(sources);
            let ui_name = contexts
                .iter()
                .find(|c| c.id == ui_cluster)
                .map(|c| c.name.as_str())
                .unwrap_or(ui_cluster);
            let _ = writeln!(
                out,
                "**Cluster mismatch:** the UI is viewing `{ui_name}` but this chat is \
                 bound to a different cluster. Native tool calls still target the chat's \
                 cluster — use `fs_configuration_use_context` if the operator wants you \
                 to act on the UI cluster instead."
            );
        }
    }

    let kind = v
        .kind_label
        .as_deref()
        .filter(|s| !s.is_empty())
        .or(v.kind_id.as_deref().filter(|s| !s.is_empty()));
    if let Some(k) = kind {
        let _ = writeln!(out, "Open view: `{k}`.");
    }

    if v.namespaces.is_empty() {
        out.push_str("Filtered namespaces: all.\n");
    } else {
        let mut ns: Vec<&str> = v.namespaces.iter().map(String::as_str).collect();
        ns.sort_unstable();
        let rendered = ns
            .iter()
            .map(|s| format!("`{s}`"))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = writeln!(out, "Filtered namespaces: {rendered}.");
    }

    if !v.selected.is_empty() {
        let _ = writeln!(out, "\nSelected rows ({}):", v.selected.len());
        for r in v.selected.iter().take(VIEW_CONTEXT_SELECTED_CAP) {
            let ns = r
                .namespace
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("-");
            let _ = writeln!(out, "- `{}` / `{}`", ns, r.name);
        }
        if v.selected.len() > VIEW_CONTEXT_SELECTED_CAP {
            let _ = writeln!(
                out,
                "- … and {} more (truncated)",
                v.selected.len() - VIEW_CONTEXT_SELECTED_CAP
            );
        }
    }

    out
}

pub(crate) fn category_label(c: ToolCategory) -> &'static str {
    match c {
        ToolCategory::Read => "read",
        ToolCategory::Write => "write",
        ToolCategory::Unknown => "unknown",
    }
}

/// Resolve an MCP tool's category. A server the operator marked
/// `trust_as_read` forces [`ToolCategory::Read`] (auto-run, no approval);
/// otherwise fall back to the name heuristic. Native tools never go through
/// here — they declare their own category.
pub(crate) fn mcp_category(trust_as_read: bool, name: &str) -> ToolCategory {
    if trust_as_read {
        ToolCategory::Read
    } else {
        classify_tool(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ViewSelectedResource;

    #[test]
    fn mcp_category_trusted_forces_read_even_for_write_names() {
        // A write-classified name from a trusted server still resolves Read.
        assert_eq!(mcp_category(true, "pods_delete"), ToolCategory::Read);
        assert_eq!(mcp_category(true, "frobnicate"), ToolCategory::Read);
    }

    #[test]
    fn mcp_category_untrusted_keeps_name_heuristic() {
        assert_eq!(mcp_category(false, "pods_delete"), ToolCategory::Write);
        assert_eq!(mcp_category(false, "pods_list"), ToolCategory::Read);
        assert_eq!(mcp_category(false, "frobnicate"), ToolCategory::Unknown);
    }

    #[test]
    fn assemble_system_prompt_only_baseline_when_others_empty() {
        let out = assemble_system_prompt("", "", None);
        assert_eq!(out, SYSTEM_PROMPT_BASELINE);
    }

    #[test]
    fn assemble_system_prompt_joins_nonempty_segments_in_order() {
        let out = assemble_system_prompt("CB", "VB", Some("OV"));
        // Each segment is appended separated by a blank line.
        assert_eq!(out, format!("{SYSTEM_PROMPT_BASELINE}\n\nCB\n\nVB\n\nOV"));
    }

    #[test]
    fn assemble_system_prompt_skips_empty_override() {
        let out = assemble_system_prompt("CB", "", Some(""));
        assert_eq!(out, format!("{SYSTEM_PROMPT_BASELINE}\n\nCB"));
    }

    #[tokio::test]
    async fn view_context_block_empty_returns_empty() {
        let state = AppState::default();
        // No view at all.
        assert!(build_view_context_block(None, "cluster-x", &state)
            .await
            .is_empty());
        // View with all fields blank.
        let blank = ViewContextWire::default();
        assert!(build_view_context_block(Some(&blank), "cluster-x", &state)
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn view_context_block_renders_kind_namespace_and_selection() {
        let state = AppState::default();
        let view = ViewContextWire {
            cluster_id: Some("cluster-x".into()),
            kind_id: Some("deployments".into()),
            kind_label: Some("Deployment".into()),
            namespaces: vec!["default".into(), "kube-system".into()],
            selected: vec![ViewSelectedResource {
                namespace: Some("default".into()),
                name: "api".into(),
            }],
        };
        // Same cluster ⇒ no mismatch warning.
        let out = build_view_context_block(Some(&view), "cluster-x", &state).await;
        assert!(out.starts_with("## What the operator is viewing"));
        assert!(out.contains("Open view: `Deployment`"));
        assert!(out.contains("`default`"));
        assert!(out.contains("`kube-system`"));
        assert!(out.contains("`default` / `api`"));
        assert!(
            !out.contains("Cluster mismatch"),
            "expected no mismatch warning when UI cluster matches the chat's active cluster"
        );
    }

    #[tokio::test]
    async fn view_context_block_calls_out_cluster_mismatch() {
        let state = AppState::default();
        let view = ViewContextWire {
            cluster_id: Some("cluster-other".into()),
            kind_label: Some("Pod".into()),
            ..Default::default()
        };
        let out = build_view_context_block(Some(&view), "cluster-x", &state).await;
        assert!(out.contains("Cluster mismatch"));
        // Empty sources ⇒ falls back to raw id rather than panicking.
        assert!(out.contains("cluster-other"));
    }

    #[tokio::test]
    async fn view_context_block_truncates_large_selections() {
        let state = AppState::default();
        let many: Vec<ViewSelectedResource> = (0..(VIEW_CONTEXT_SELECTED_CAP + 5))
            .map(|i| ViewSelectedResource {
                namespace: Some("default".into()),
                name: format!("pod-{i}"),
            })
            .collect();
        let view = ViewContextWire {
            selected: many,
            ..Default::default()
        };
        let out = build_view_context_block(Some(&view), "cluster-x", &state).await;
        // First few rows render; the rest collapse into a single summary line.
        assert!(out.contains("`default` / `pod-0`"));
        assert!(out.contains("and 5 more"));
        // Header shows the true count, not the cap.
        assert!(out.contains(&format!(
            "Selected rows ({}):",
            VIEW_CONTEXT_SELECTED_CAP + 5
        )));
    }
}
