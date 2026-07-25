//! `agent::commands` — see `agent/mod.rs` for the split rationale.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ferrisscope_agent::config::McpServerConfig;
use ferrisscope_agent::provider::meta::{self, ProviderMeta};
use ferrisscope_agent::session::{
    ApprovalDecision, SessionData, SessionEvent, SessionMeta, SessionUpdate,
};
use ferrisscope_agent::types::{ChatMessage, ImageAttachment, MessageRole};
use ferrisscope_agent::{
    ApprovalMode, ChatProvider, Credential, FinishReason, ModelInfo, ProviderKind,
    ReasoningSettings,
};
use ferrisscope_core::kubeconfig;
use tauri::{ipc::Channel, State};
use tokio::sync::Mutex;

use crate::agent_mcp::{McpProcess, McpProcessError};
use crate::agent_native;
use crate::agent_oauth;
use crate::secret_storage::{self};
use crate::state::AppState;

use super::{
    assemble_system_prompt, autocontinue_if_idle, build_cluster_context_block, build_provider,
    build_view_context_block, category_label, clear_credential, close_chat_runtime,
    context_limits_for, effective_credential, load_persisted, make_credential_sink, mcp_category,
    read_credential, repair_orphan_tool_calls, resolve_provider_options, run_auto_title_task,
    run_compaction_internal, run_turn_loop, save_persisted, secret_storage_available_cached,
    session_err_to_string, snapshot_for_title, write_credential, AgentState, AiSettingsPatch,
    AiSettingsWire, ChatEvent, ChatOpenResult, ChatRuntime, ChatToolWire, McpServerHandle,
    McpServerStatusWire, McpTestResult, ProviderStatusWire, ProviderTestRequest,
    ProviderTestResult, ViewContextWire,
};

#[tauri::command]
pub(crate) async fn ai_get_settings(
    _state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    let p = load_persisted().await;
    let kc_available = secret_storage_available_cached();
    let storage_backend = secret_storage::backend();
    let mut providers = HashMap::with_capacity(ProviderKind::all().len());
    for kind in ProviderKind::all() {
        let m: &ProviderMeta = meta::for_kind(*kind);
        let provider_cfg = p.settings.providers.get(kind);
        let base_url_override = provider_cfg.and_then(|c| c.base_url.clone());
        let custom_models = provider_cfg
            .map(|c| c.custom_models.clone())
            .unwrap_or_default();
        let cred = read_credential(*kind).await;
        // Providers with a public fallback (OpenCode Zen's free tier)
        // report as configured even without an operator credential —
        // chat / model-listing paths use `effective_credential` and
        // the request still succeeds. We surface the distinction
        // through `account_label = "free tier"` so the UI can show
        // operators which mode they're in.
        let public_fallback_active = cred.is_none() && kind.public_fallback_key().is_some();
        let auth_mode = if public_fallback_active {
            Some("api_key".to_string())
        } else {
            cred.as_ref()
                .map(Credential::auth_mode_label)
                .map(str::to_string)
        };
        let account_label = if public_fallback_active {
            Some("free tier".to_string())
        } else {
            cred.as_ref().and_then(|c| match c {
                Credential::OAuth { account_id, .. } => account_id.clone(),
                _ => None,
            })
        };
        providers.insert(
            *kind,
            ProviderStatusWire {
                kind: *kind,
                id: m.id.to_string(),
                display_name: m.display_name.to_string(),
                default_base_url: m.default_base_url.to_string(),
                base_url_override,
                auth_modes: m
                    .auth_modes
                    .iter()
                    .map(|m| match m {
                        ferrisscope_agent::AuthMode::ApiKey => "api_key".to_string(),
                        ferrisscope_agent::AuthMode::OAuth => "oauth".to_string(),
                    })
                    .collect(),
                auth_mode,
                configured: cred.is_some() || public_fallback_active,
                account_label,
                custom_models,
            },
        );
    }
    Ok(AiSettingsWire {
        active_provider: p.settings.active_provider,
        providers,
        default_model: p.settings.default_model.clone(),
        default_approval_mode: p.settings.default_approval_mode,
        system_prompt_override: p.settings.system_prompt_override.clone(),
        allow_plaintext_api_key: p.settings.allow_plaintext_api_key,
        keychain_available: kc_available,
        secret_storage_backend: storage_backend,
        mcp_servers: p.settings.mcp_servers.clone(),
        mcp_binary_path: p.settings.mcp_binary_path.clone(),
        reasoning: p.settings.reasoning,
    })
}

#[tauri::command]
pub(crate) async fn ai_set_settings(
    patch: AiSettingsPatch,
    state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    let mut p = load_persisted().await;
    if let Some(k) = patch.active_provider {
        p.settings.active_provider = k;
    }
    if let Some(bu) = patch.provider_base_url {
        let cfg = p.settings.providers.entry(bu.provider).or_default();
        cfg.base_url = if bu.base_url.is_empty() {
            None
        } else {
            Some(bu.base_url)
        };
    }
    if let Some(cm) = patch.provider_custom_models {
        let cfg = p.settings.providers.entry(cm.provider).or_default();
        // Normalise: trim, drop empties, dedupe preserving operator order.
        let mut seen = HashSet::new();
        cfg.custom_models = cm
            .models
            .into_iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .filter(|m| seen.insert(m.clone()))
            .collect();
    }
    if let Some(m) = patch.default_model {
        p.settings.default_model = if m.is_empty() { None } else { Some(m) };
    }
    if let Some(am) = patch.default_approval_mode {
        p.settings.default_approval_mode = am;
    }
    if let Some(s) = patch.system_prompt_override {
        p.settings.system_prompt_override = if s.is_empty() { None } else { Some(s) };
    }
    if let Some(allow_plaintext) = patch.allow_plaintext_api_key {
        p.settings.allow_plaintext_api_key = allow_plaintext;
        if !allow_plaintext {
            p.plaintext_credentials.clear();
        }
    }
    if let Some(path) = patch.mcp_binary_path {
        p.settings.mcp_binary_path = if path.is_empty() { None } else { Some(path) };
    }
    if let Some(servers) = patch.mcp_servers {
        // Normalise: drop entries the operator added then abandoned — empty
        // name *and* no endpoint (no command for stdio, no url for remote).
        // Trim names / urls so whitespace doesn't sneak into status messages.
        p.settings.mcp_servers = servers
            .into_iter()
            .filter_map(|mut s| {
                s.name = s.name.trim().to_string();
                s.command = s.command.trim().to_string();
                s.url = s
                    .url
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty());
                let no_endpoint = s.command.is_empty() && s.url.is_none();
                if s.name.is_empty() && no_endpoint {
                    None
                } else {
                    Some(s)
                }
            })
            .collect();
    }
    if let Some(reasoning) = patch.reasoning {
        // UI sends `0` from the budget select's "off" option; coerce
        // to `None` so we don't ship `budget_tokens: 0` (which some
        // providers treat as enabled-but-zero — pure tax).
        p.settings.reasoning = ReasoningSettings {
            effort: reasoning.effort,
            budget_tokens: reasoning.budget_tokens.filter(|b| *b > 0),
        };
    }

    save_persisted(&p).await.map_err(|e| e.to_string())?;
    ai_get_settings(state).await
}

/// Persist a credential for `provider`. Used by both the API-key form
/// (`Credential::ApiKey`) and the OAuth flow's success path
/// (`Credential::OAuth`). The frontend never reads back the credential
/// — just the boolean `configured` flag in `AiSettingsWire`.
#[tauri::command]
pub(crate) async fn ai_set_credential(
    provider: ProviderKind,
    credential: Credential,
    state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    write_credential(provider, &credential).await?;
    ai_get_settings(state).await
}

#[tauri::command]
pub(crate) async fn ai_delete_credential(
    provider: ProviderKind,
    state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    clear_credential(provider).await?;
    ai_get_settings(state).await
}

#[tauri::command]
pub(crate) async fn ai_oauth_login(
    provider: ProviderKind,
    app: tauri::AppHandle,
    state: State<'_, AgentState>,
) -> Result<AiSettingsWire, String> {
    let cred = agent_oauth::login(app, provider)
        .await
        .map_err(|e| e.to_string())?;
    write_credential(provider, &cred).await?;
    ai_get_settings(state).await
}

#[tauri::command]
pub(crate) async fn ai_oauth_cancel() -> Result<(), String> {
    agent_oauth::cancel().await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_test_provider(
    req: ProviderTestRequest,
    _state: State<'_, AgentState>,
) -> Result<ProviderTestResult, String> {
    // Blank key = "test the saved credential" — the settings row lets the
    // operator re-validate an already-persisted connection without
    // re-pasting the secret (which never round-trips to the frontend).
    // With nothing stored we still probe unauthenticated: open endpoints
    // (local Ollama, some gateways) answer `GET /models` with no auth,
    // and closed ones 401 — which is itself the correct test result.
    let cred = if req.api_key.trim().is_empty() {
        read_credential(req.provider)
            .await
            .unwrap_or(Credential::ApiKey { key: String::new() })
    } else {
        Credential::ApiKey { key: req.api_key }
    };

    // Probe the live `GET /models` endpoint directly rather than going
    // through `ChatProvider::list_models` — that path deliberately falls
    // back to the models.dev catalogue / static list when the network
    // fails, which would mask a bad key or wrong base URL behind a
    // phantom "OK · N models". The test button exists to validate the
    // *connection*, so only a live 200 counts.
    let m: &ProviderMeta = meta::for_kind(req.provider);
    let base_url = req
        .base_url
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| m.default_base_url.to_string());
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let key = match &cred {
        Credential::ApiKey { key } => key.trim().to_string(),
        Credential::OAuth { access, .. } => access.clone(),
    };
    let mut http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url);
    if !key.is_empty() {
        http = match m.flavor {
            // Anthropic's first-party auth style (`x-api-key` + version);
            // every OpenAI-shaped endpoint takes a Bearer token.
            ferrisscope_agent::ProviderFlavor::AnthropicMessages => http
                .header("x-api-key", &key)
                .header("anthropic-version", "2023-06-01"),
            _ => http.bearer_auth(&key),
        };
    }
    match http.send().await {
        Err(e) => Ok(ProviderTestResult {
            ok: false,
            model_count: 0,
            error: Some(format!("cannot reach {url}: {e}")),
        }),
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() {
                let code = status.as_u16();
                let body = resp.text().await.unwrap_or_default();
                // Trim noisy HTML / long JSON error bodies for the chip.
                let trimmed = body.trim();
                let snippet = if trimmed.len() > 200 {
                    format!("{}…", &trimmed[..200])
                } else {
                    trimmed.to_string()
                };
                return Ok(ProviderTestResult {
                    ok: false,
                    model_count: 0,
                    error: Some(if snippet.is_empty() {
                        format!("HTTP {code} from {url}")
                    } else {
                        format!("HTTP {code}: {snippet}")
                    }),
                });
            }
            // Both shapes we care about (`{data:[{id}]}` OpenAI-style and
            // Anthropic's `{data:[{id, display_name}]}`) hang the list off
            // `data`; count entries without parsing the full shape.
            let body = resp.text().await.unwrap_or_default();
            let count = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("data")?.as_array().map(Vec::len));
            match count {
                Some(n) => Ok(ProviderTestResult {
                    ok: true,
                    model_count: n,
                    error: None,
                }),
                None => Ok(ProviderTestResult {
                    ok: false,
                    model_count: 0,
                    error: Some(
                        "reachable but `GET /models` returned no `data` list — this endpoint may not enumerate models; add custom models below".to_string(),
                    ),
                }),
            }
        }
    }
}

/// How many tool names to surface on a successful test response. Operators
/// see this in a hover hint; we don't need the full catalogue, just enough
/// to confirm the right server answered.
const MCP_TEST_NAME_PREVIEW: usize = 12;

/// Cap on captured stderr bytes. Enough to show the failing line plus a
/// few lines of context, not enough to OOM if the child is in a logging
/// loop. Tail-bias: when we hit the cap we keep the most recent lines.
const MCP_TEST_STDERR_CAP: usize = 8192;

/// Timeouts for the test path — generous because tools like `npx -y` cold
/// download the package on first run (frequently 20–40s). The production
/// chat-open path has tighter budgets; we don't share them.
const MCP_TEST_OVERALL: std::time::Duration = std::time::Duration::from_secs(90);

const MCP_TEST_INITIALIZE: std::time::Duration = std::time::Duration::from_mins(1);

const MCP_TEST_LIST_TOOLS: std::time::Duration = std::time::Duration::from_secs(30);

#[tauri::command]
pub(crate) async fn mcp_test_server(
    config: McpServerConfig,
    _state: State<'_, AgentState>,
) -> Result<McpTestResult, String> {
    use std::process::Stdio;
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;
    use tokio::sync::Mutex as AsyncMutex;

    // Remote transports (sse / http) have no subprocess and no stderr to
    // capture — connect over the network and run the same handshake.
    if config.transport.is_remote() {
        return Ok(mcp_test_remote(&config).await);
    }

    let bin = config.command.trim();
    if bin.is_empty() {
        return Ok(McpTestResult {
            ok: false,
            tool_count: 0,
            tool_names: Vec::new(),
            error: Some("command is empty".to_string()),
        });
    }

    // Spawn the child ourselves rather than going through `McpProcess::spawn`
    // — we want a longer initialize budget (npx-y cold-starts), and we want
    // to capture stderr into the response so a failure mode like "module
    // not found" or "permission denied" is visible to the operator instead
    // of vanishing into our tracing log.
    let mut cmd = Command::new(bin);
    if !config.args.is_empty() {
        cmd.args(&config.args);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in &config.env {
        cmd.env(k, v);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Ok(McpTestResult {
                ok: false,
                tool_count: 0,
                tool_names: Vec::new(),
                error: Some(format!("failed to spawn `{bin}`: {e}")),
            });
        }
    };

    let stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            return Ok(McpTestResult {
                ok: false,
                tool_count: 0,
                tool_names: Vec::new(),
                error: Some("child has no stdin pipe".to_string()),
            });
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            return Ok(McpTestResult {
                ok: false,
                tool_count: 0,
                tool_names: Vec::new(),
                error: Some("child has no stdout pipe".to_string()),
            });
        }
    };

    // Capture stderr into a tail-biased buffer. Drains continuously so the
    // pipe doesn't fill and stall the child; on cap-overflow we drop the
    // *front* so the most recent lines (likely containing the failure
    // reason) survive.
    let stderr_buf: Arc<AsyncMutex<String>> = Arc::new(AsyncMutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let mut g = buf.lock().await;
                        g.push_str(&line);
                        if g.len() > MCP_TEST_STDERR_CAP {
                            // Trim to keep the last cap bytes; aligns to the
                            // next newline so we don't bisect an entry mid-
                            // line for the operator to read.
                            let drop_to = g.len() - MCP_TEST_STDERR_CAP;
                            let cut = g[drop_to..].find('\n').map_or(drop_to, |i| drop_to + i + 1);
                            g.drain(..cut);
                        }
                    }
                }
            }
        });
    }

    let client = ferrisscope_agent::McpClient::new(stdin, stdout);

    let outcome: Result<Vec<ferrisscope_agent::mcp::McpTool>, String> =
        tokio::time::timeout(MCP_TEST_OVERALL, async {
            tokio::time::timeout(
                MCP_TEST_INITIALIZE,
                client.initialize("ferrisscope", env!("CARGO_PKG_VERSION")),
            )
            .await
            .map_err(|_| "MCP `initialize` timed out — server didn't respond in 60s".to_string())?
            .map_err(|e| format!("MCP `initialize` failed: {e}"))?;

            tokio::time::timeout(MCP_TEST_LIST_TOOLS, client.list_tools())
                .await
                .map_err(|_| {
                    "MCP `tools/list` timed out — server didn't respond in 30s".to_string()
                })?
                .map_err(|e| format!("MCP `tools/list` failed: {e}"))
        })
        .await
        .unwrap_or_else(|_| Err("test timed out after 90s overall".to_string()));

    // Kill the child explicitly. `kill_on_drop` covers us anyway, but this
    // signals immediately rather than waiting for the wrapper Drop.
    let _ = child.start_kill();
    // Give the stderr reader a brief moment to drain anything the child
    // emitted on its way out — final messages often carry the cause.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let captured = stderr_buf.lock().await.clone();
    let stderr_tail = if captured.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nstderr:\n{}", captured.trim_end())
    };

    Ok(match outcome {
        Ok(tools) => {
            #[allow(clippy::cast_possible_truncation)]
            let tool_count = tools.len() as u32;
            let tool_names = tools
                .iter()
                .take(MCP_TEST_NAME_PREVIEW)
                .map(|t| t.name.clone())
                .collect();
            McpTestResult {
                ok: true,
                tool_count,
                tool_names,
                error: None,
            }
        }
        Err(e) => McpTestResult {
            ok: false,
            tool_count: 0,
            tool_names: Vec::new(),
            error: Some(format!("{e}{stderr_tail}")),
        },
    })
}

/// Test a remote (`sse` / `http`) MCP server: connect, run `initialize` +
/// `tools/list`, and report the tool count. No subprocess / stderr (those are
/// stdio-only), so failures surface as the transport / handshake error text.
async fn mcp_test_remote(config: &McpServerConfig) -> McpTestResult {
    use ferrisscope_agent::mcp::{HttpTransport, SseTransport};

    let err = |msg: String| McpTestResult {
        ok: false,
        tool_count: 0,
        tool_names: Vec::new(),
        error: Some(msg),
    };

    let url = config.url.as_deref().map(str::trim).unwrap_or("");
    if url.is_empty() {
        return err("url is empty".to_string());
    }

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let client = match config.transport {
        ferrisscope_agent::McpTransport::Http => {
            match HttpTransport::connect(url, &config.headers, tx) {
                Ok(t) => ferrisscope_agent::McpClient::from_transport(t, rx),
                Err(e) => return err(format!("connect failed: {e}")),
            }
        }
        ferrisscope_agent::McpTransport::Sse => {
            match SseTransport::connect(url, &config.headers, tx).await {
                Ok(t) => ferrisscope_agent::McpClient::from_transport(t, rx),
                Err(e) => return err(format!("connect failed: {e}")),
            }
        }
        ferrisscope_agent::McpTransport::Stdio => {
            return err("internal: stdio routed to remote test".to_string());
        }
    };

    let outcome: Result<Vec<ferrisscope_agent::mcp::McpTool>, String> =
        tokio::time::timeout(MCP_TEST_OVERALL, async {
            tokio::time::timeout(
                MCP_TEST_INITIALIZE,
                client.initialize("ferrisscope", env!("CARGO_PKG_VERSION")),
            )
            .await
            .map_err(|_| "MCP `initialize` timed out".to_string())?
            .map_err(|e| format!("MCP `initialize` failed: {e}"))?;

            tokio::time::timeout(MCP_TEST_LIST_TOOLS, client.list_tools())
                .await
                .map_err(|_| "MCP `tools/list` timed out".to_string())?
                .map_err(|e| format!("MCP `tools/list` failed: {e}"))
        })
        .await
        .unwrap_or_else(|_| Err("test timed out after 90s overall".to_string()));

    match outcome {
        Ok(tools) => {
            #[allow(clippy::cast_possible_truncation)]
            let tool_count = tools.len() as u32;
            McpTestResult {
                ok: true,
                tool_count,
                tool_names: tools
                    .iter()
                    .take(MCP_TEST_NAME_PREVIEW)
                    .map(|t| t.name.clone())
                    .collect(),
                error: None,
            }
        }
        Err(e) => err(e),
    }
}

/// Merge the operator's custom model ids into an enumerated list. Ids
/// already present (live `/models`, catalogue, or static) win so their
/// display name / context length survive; new ids append bare. This is
/// the only model source for endpoints that can't enumerate at all.
fn merge_custom_models(
    models: &mut Vec<ModelInfo>,
    cfg: Option<&ferrisscope_agent::ProviderConfig>,
) {
    let Some(cfg) = cfg else { return };
    let existing: HashSet<String> = models.iter().map(|m| m.id.clone()).collect();
    for id in &cfg.custom_models {
        if !existing.contains(id.as_str()) {
            models.push(ModelInfo {
                id: id.clone(),
                name: None,
                context_length: None,
            });
        }
    }
}

/// List models for a provider. Defaults to `active_provider` when
/// `provider` is absent so the existing single-provider call sites keep
/// working. The provider must already be configured (credential set).
#[tauri::command]
pub(crate) async fn ai_list_models(
    provider: Option<ProviderKind>,
    _state: State<'_, AgentState>,
) -> Result<Vec<ModelInfo>, String> {
    let p = load_persisted().await;
    let kind = provider.unwrap_or(p.settings.active_provider);
    // Determine whether the public-tier fallback is in effect *before*
    // we hand the credential to the provider — the upstream catalogue
    // doesn't gate models by key, so we filter client-side from
    // models.dev cost data when no operator key is present.
    let operator_credential = read_credential(kind).await;
    let public_fallback_active =
        operator_credential.is_none() && kind.public_fallback_key().is_some();
    let cred = operator_credential
        .or_else(|| {
            kind.public_fallback_key().map(|key| Credential::ApiKey {
                key: key.to_string(),
            })
        })
        .ok_or_else(|| "no credential configured for this provider".to_string())?;
    let base_url = p
        .settings
        .providers
        .get(&kind)
        .and_then(|c| c.base_url.clone());
    let provider_impl = build_provider(kind, &cred, base_url, None, None)?;
    let mut models = match provider_impl.list_models().await {
        Ok(m) => m,
        Err(e) => {
            // Enumeration failed (endpoint down, bad key, or no `/models`
            // at all). If the operator maintains a custom list, return
            // that instead of erroring — for custom gateways it's the
            // designed path, and for built-ins it still leaves the
            // picker usable while surfacing nothing misleading (the
            // custom ids are the operator's own).
            let mut v = Vec::new();
            merge_custom_models(&mut v, p.settings.providers.get(&kind));
            if v.is_empty() {
                return Err(e.to_string());
            }
            return Ok(v);
        }
    };
    merge_custom_models(&mut models, p.settings.providers.get(&kind));
    // OpenCode Zen on the public tier — drop everything the catalogue
    // marks as paid. Mirrors opencode's `cost.input === 0` filter.
    // When the catalogue hasn't loaded yet for this provider we leave
    // the list alone (better to show all and let the upstream reject
    // paid-model requests than to show an empty picker on first run).
    if public_fallback_active && ferrisscope_agent::provider::catalogue::has_data_for(kind) {
        models.retain(|m| ferrisscope_agent::provider::catalogue::is_known_free(kind, &m.id));
    }
    // Sort by opencode's priority list so the picker (and any caller
    // that reads `[0]` as a default) sees the best candidate first —
    // `big-pickle` on OpenCode Zen free tier, `gpt-5.x` on OpenAI,
    // `claude-sonnet-4-x` on Anthropic, etc. Stable across runs; the
    // catalogue cache is populated at startup.
    {
        let mut ids: Vec<String> = models.iter().map(|m| m.id.clone()).collect();
        ferrisscope_agent::provider::catalogue::sort_for_default(&mut ids);
        let order: std::collections::HashMap<String, usize> =
            ids.into_iter().enumerate().map(|(i, s)| (s, i)).collect();
        models.sort_by_key(|m| order.get(&m.id).copied().unwrap_or(usize::MAX));
    }
    Ok(models)
}

#[tauri::command]
pub(crate) async fn chat_create_session(
    cluster_id: String,
    model: Option<String>,
    state: State<'_, AgentState>,
) -> Result<SessionMeta, String> {
    let store = state.store().await?;
    let mut p = load_persisted().await;
    // Resolution order:
    //  1. caller-supplied `model` (used by chat_open's pickModel()
    //     fast path and the provider-switch flow).
    //  2. `settings.default_model` from the operator.
    //  3. First entry of the active provider's catalogue, sorted by
    //     opencode's priority list — falls through to whatever the
    //     provider returns when the priority list misses entirely.
    // Whatever lands in the meta also gets written back to settings as
    // `default_model` if the operator hadn't picked one yet, so the
    // Settings → AI panel reflects the same choice instead of
    // perpetually showing "—" until they manually pick.
    let mut model_id = model
        .or_else(|| p.settings.default_model.clone())
        .unwrap_or_default();
    let mut should_persist_default = false;
    if model_id.is_empty() {
        let kind = p.settings.active_provider;
        if let Some(cred) = effective_credential(kind).await {
            let base_url = p
                .settings
                .providers
                .get(&kind)
                .and_then(|c| c.base_url.clone());
            if let Ok(provider_impl) = build_provider(kind, &cred, base_url, None, None) {
                if let Ok(mut list) = provider_impl.list_models().await {
                    merge_custom_models(&mut list, p.settings.providers.get(&kind));
                    let public_fallback_active = matches!(cred, Credential::ApiKey { ref key } if Some(key.as_str()) == kind.public_fallback_key());
                    if public_fallback_active
                        && ferrisscope_agent::provider::catalogue::has_data_for(kind)
                    {
                        list.retain(|m| {
                            ferrisscope_agent::provider::catalogue::is_known_free(kind, &m.id)
                        });
                    }
                    let mut ids: Vec<String> = list.into_iter().map(|m| m.id).collect();
                    ferrisscope_agent::provider::catalogue::sort_for_default(&mut ids);
                    if let Some(first) = ids.into_iter().next() {
                        model_id = first;
                        should_persist_default = p.settings.default_model.is_none();
                    }
                }
            }
        }
    }
    if should_persist_default && !model_id.is_empty() {
        p.settings.default_model = Some(model_id.clone());
        let _ = save_persisted(&p).await;
    }
    let now = chrono::Utc::now().timestamp_millis();
    let meta = SessionMeta {
        id: uuid::Uuid::new_v4().to_string(),
        cluster_id,
        title: "New chat".to_string(),
        created_at_unix_ms: now,
        updated_at_unix_ms: now,
        provider_kind: p.settings.active_provider,
        model: model_id,
        approval_mode: p.settings.default_approval_mode,
        temperature: None,
        max_tokens: None,
        provider_options: None,
        last_total_tokens: None,
        active_cluster_id: None,
    };
    store
        .create(meta.clone())
        .await
        .map_err(session_err_to_string)?;
    Ok(meta)
}

#[tauri::command]
pub(crate) async fn chat_list_sessions(
    cluster_id: Option<String>,
    state: State<'_, AgentState>,
) -> Result<Vec<SessionMeta>, String> {
    let store = state.store().await?;
    store
        .list(cluster_id.as_deref())
        .await
        .map_err(session_err_to_string)
}

#[tauri::command]
pub(crate) async fn chat_load_session(
    session_id: String,
    state: State<'_, AgentState>,
) -> Result<SessionData, String> {
    let store = state.store().await?;
    store.load(&session_id).await.map_err(session_err_to_string)
}

#[tauri::command]
pub(crate) async fn chat_rename_session(
    session_id: String,
    title: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let store = state.store().await?;
    store
        .rename(&session_id, title)
        .await
        .map_err(session_err_to_string)
}

#[tauri::command]
pub(crate) async fn chat_delete_session(
    session_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let store = state.store().await?;
    store
        .delete(&session_id)
        .await
        .map_err(session_err_to_string)
}

#[tauri::command]
pub(crate) async fn chat_open(
    session_id: String,
    on_event: Channel<ChatEvent>,
    app: tauri::AppHandle,
    state: State<'_, AgentState>,
    app_state: State<'_, AppState>,
) -> Result<ChatOpenResult, String> {
    let store = state.store().await?;
    let data = store
        .load(&session_id)
        .await
        .map_err(session_err_to_string)?;

    let messages: Vec<ChatMessage> = data
        .events
        .iter()
        .filter_map(|e| {
            if let SessionEvent::Message { message, .. } = e {
                Some(message.clone())
            } else {
                None
            }
        })
        .collect();

    // Most recent Usage event seeds the running token count on
    // reopen. The session index keeps it on the meta so this is
    // O(1); we also fall back to scanning the events when the meta
    // doesn't carry the field (older sessions that pre-date Usage
    // tracking, or during the brief window before the first Usage
    // appends).
    let last_usage_from_events: Option<(u32, u32, u32)> = data.events.iter().rev().find_map(|e| {
        if let SessionEvent::Usage {
            prompt_tokens,
            completion_tokens,
            total_tokens,
            ..
        } = e
        {
            Some((*prompt_tokens, *completion_tokens, *total_tokens))
        } else {
            None
        }
    });
    let seeded_total = data
        .meta
        .last_total_tokens
        .or_else(|| last_usage_from_events.map(|(_, _, t)| t))
        .unwrap_or(0);

    // Resolve the kubeconfig path AND context name for this session's
    // cluster, so the MCP server targets the chat's bound context — not
    // whatever happens to be `current-context:` in the source file. We pin
    // it via a per-chat scratch override (see McpProcess::spawn). Failing
    // to resolve is non-fatal — we fall back to the source's current-context.
    //
    // SSH sources need a different shape: we materialise a self-contained
    // scratch kubeconfig pointing at the local SSH tunnel port (the same
    // tunnel our in-process kube client already uses), then pass it as
    // `external_scratch` so the merge logic is bypassed. The cluster must
    // be pre-connected so the tunnel exists before we read its port; we
    // call `state.entry()` here for both branches because connect is a
    // no-op if the entry already exists.
    let (kubeconfig_path, context_name) = {
        let sources = app_state.sources.lock().await;
        let path = kubeconfig::resolve_path_for(&data.meta.cluster_id, &sources);
        let ctx = kubeconfig::context_name_from_id(&data.meta.cluster_id).to_string();
        (path, ctx)
    };

    let cluster_id_for_mcp = data.meta.cluster_id.clone();
    // Build the SSH scratch kubeconfig if this cluster is SSH-sourced. Done
    // before the MCP child spawn task is queued so a failure here surfaces
    // as a clean error in the chat (we still proceed; the chat is usable
    // with native tools only).
    let external_scratch = crate::ssh_scratch::materialize_if_needed(
        &cluster_id_for_mcp,
        &context_name,
        "mcp",
        &app_state,
    )
    .await;

    // External MCP servers — operator-configured only. Empty list = chat
    // runs with native tools only (which cover the full kubernetes
    // management surface). The `mcp_servers` list wins; when empty we
    // fall back to the legacy single-binary `mcp_binary_path` so older
    // configs keep working without a save migration.
    let persisted = load_persisted().await;
    let mcp_servers_cfg: Vec<McpServerConfig> = if !persisted.settings.mcp_servers.is_empty() {
        persisted
            .settings
            .mcp_servers
            .iter()
            .filter(|s| s.enabled)
            .cloned()
            .collect()
    } else if let Some(legacy) = persisted
        .settings
        .mcp_binary_path
        .as_ref()
        .filter(|p| !p.trim().is_empty())
    {
        vec![McpServerConfig {
            id: "legacy".to_string(),
            name: "MCP server".to_string(),
            transport: ferrisscope_agent::config::McpTransport::Stdio,
            command: legacy.clone(),
            url: None,
            args: Vec::new(),
            env: HashMap::new(),
            headers: HashMap::new(),
            trust_as_read: false,
            enabled: true,
        }]
    } else {
        Vec::new()
    };

    // Native tools are built unconditionally and per-chat. They share a
    // `ChatClusterCtx` whose `origin` is the session-bound cluster and
    // whose `active` defaults to origin (or the agent's last-persisted
    // override when one survives in `meta.active_cluster_id`).
    // `fs_configuration_use_context` can rebind active mid-chat without
    // touching the chat's session-bound cluster (which still drives
    // storage, auto-title, and MCP child auth). The same `Arc` is also
    // stored on `ChatRuntime` so the per-turn system-prompt builder can
    // read the active cluster without a tool call.
    //
    // Restoration safety: if the persisted active id is no longer in the
    // operator's sources (they removed that kubeconfig), fall back to
    // origin AND clear the stale override on disk so subsequent reopens
    // don't keep tripping. Better silent than failing every tool call.
    let restored_active: Option<String> = match data.meta.active_cluster_id.as_deref() {
        Some(saved) if saved != data.meta.cluster_id => {
            let sources = app_state.sources.lock().await;
            let resolves = ferrisscope_core::kubeconfig::list_contexts(&sources)
                .map(|cs| cs.iter().any(|c| c.id == saved))
                .unwrap_or(false);
            drop(sources);
            if resolves {
                Some(saved.to_string())
            } else {
                tracing::info!(
                    saved = saved,
                    origin = %data.meta.cluster_id,
                    "chat_open: persisted active cluster no longer resolves; reverting to origin",
                );
                let _ = store
                    .append(
                        &data.meta.cluster_id,
                        &session_id,
                        SessionEvent::SessionUpdate {
                            update: SessionUpdate {
                                active_cluster_id: Some(None),
                                ..Default::default()
                            },
                            ts: chrono::Utc::now().timestamp_millis(),
                        },
                    )
                    .await;
                None
            }
        }
        _ => None,
    };
    let cluster_ctx = agent_native::ChatClusterCtx::new(
        data.meta.cluster_id.clone(),
        session_id.clone(),
        restored_active,
    );
    // Per-chat disk spool for oversized tool output. Built from the stable
    // (cluster, session) pair so a reopened chat resolves the same handles its
    // rehydrated transcript references. Reap stale spills opportunistically on
    // open (best-effort, off the open path).
    let tool_spool = agent_native::tool_output::ToolSpool::new(&data.meta.cluster_id, &session_id);
    tauri::async_runtime::spawn(agent_native::tool_output::sweep_expired());
    let native = agent_native::build_registry(app.clone(), cluster_ctx.clone(), tool_spool.clone());

    let chat_id = format!("chat-{}", uuid::Uuid::new_v4());
    let on_event_for_replay = on_event.clone();
    let last_usage_for_replay = last_usage_from_events;
    // Pre-populate the per-server handles in pending state so the initial
    // McpStatus event has the right server count — the UI can render the
    // "starting…" rows immediately while spawns settle in the background.
    let pending_servers: Vec<McpServerHandle> = mcp_servers_cfg
        .iter()
        .map(|s| McpServerHandle {
            id: s.id.clone(),
            name: s.name.clone(),
            process: None,
            tools: Vec::new(),
            trust_as_read: s.trust_as_read,
            message: None,
        })
        .collect();
    let runtime = Arc::new(Mutex::new(ChatRuntime {
        session_id,
        cluster_id: data.meta.cluster_id.clone(),
        model: data.meta.model.clone(),
        provider_kind: data.meta.provider_kind,
        approval_mode: data.meta.approval_mode,
        temperature: data.meta.temperature,
        max_tokens: data.meta.max_tokens,
        provider_options: data.meta.provider_options.clone(),
        last_total_tokens: seeded_total,
        compaction_in_flight: false,
        channel: on_event,
        messages,
        cancel: None,
        in_flight_message_id: None,
        mcp_servers: pending_servers,
        external_scratch: external_scratch.clone(),
        native,
        cluster: cluster_ctx,
        tool_spool,
        pending_approvals: HashMap::new(),
        approved_always: HashSet::new(),
        // Reset every chat-open. The persisted `meta.title` is the
        // source of truth: if it's still the placeholder when the
        // first turn finishes, we attempt auto-naming exactly once.
        auto_title_done: false,
        last_view_context: None,
    }));
    state
        .chats
        .lock()
        .await
        .insert(chat_id.clone(), runtime.clone());

    // Belt-and-braces replay of the most recent persisted Usage so
    // the chat-header chip shows the running total immediately. The
    // primary path is the meta field (read directly by the UI from
    // chat_load_session); this Channel.send is the fallback for the
    // open-without-load path. Send is non-blocking — Tauri queues it
    // on the existing Channel; the JS handler is already attached
    // (set up in api.chatOpen before invoke).
    if let Some((p, c, t)) = last_usage_for_replay {
        // Spawn so we don't hold up chat_open's return on a slow IPC
        // post (the Channel send is sync-ish but the queue write
        // takes a write lock); the user-perceived latency on chat
        // open shouldn't include this.
        let chan = on_event_for_replay;
        let (context_limit, usable_context) =
            context_limits_for(data.meta.provider_kind, &data.meta.model);
        tauri::async_runtime::spawn(async move {
            // Brief delay so the JS-side promise settles `chatId` and
            // any state-init effects fire before the Usage event
            // arrives. Without this, races like "frontend resets
            // usage state on chat-id change AFTER our send" leave
            // the chip empty.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = chan.send(ChatEvent::Usage {
                prompt_tokens: p,
                completion_tokens: c,
                total_tokens: t,
                context_limit,
                usable_context,
            });
        });
    }

    // Heal any orphan tool_calls left over from a previously cancelled
    // / crashed turn. The next provider call would 400 otherwise. We
    // run this immediately on open rather than only at turn-start so
    // re-opening a chat after a crash leaves the in-memory transcript
    // self-consistent for the model picker / preview UI too.
    {
        let store_for_heal = match state.store().await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "chat_open: cannot acquire store for orphan repair");
                let initial = initial_status_for_open(&runtime).await;
                let (context_limit, usable_context) =
                    context_limits_for(data.meta.provider_kind, &data.meta.model);
                return Ok(ChatOpenResult {
                    chat_id,
                    native_tool_count: initial.0,
                    mcp_servers: initial.1,
                    context_limit,
                    usable_context,
                });
            }
        };
        let cluster_for_heal = data.meta.cluster_id.clone();
        let session_for_heal = data.meta.id.clone();
        repair_orphan_tool_calls(
            &runtime,
            &store_for_heal,
            &cluster_for_heal,
            &session_for_heal,
        )
        .await;
    }

    // Emit the initial status now so the inspector renders without
    // sitting on "Checking…" — every configured server is in pending
    // state until its background task lands a result. The same
    // snapshot is also returned in-band by `ChatOpenResult` so the
    // frontend can seed `view.mcp` synchronously without waiting on
    // the streamed event (Tauri channel events sent during the same
    // invoke can arrive AFTER the JS-side state-init effects, leaving
    // the chip stuck on "Tools · …"). The streamed event is kept for
    // operators who already have a chat open and re-emit via
    // `chat_refresh_status`.
    emit_mcp_status(&runtime).await;

    if mcp_servers_cfg.is_empty() {
        // No servers configured — the SSH scratch we speculatively
        // materialised has no consumer. Clear it from the runtime so the
        // chat_close cleanup is a no-op. Best-effort delete.
        let leftover = {
            let mut g = runtime.lock().await;
            g.external_scratch.take()
        };
        if let Some(p) = leftover {
            let _ = std::fs::remove_file(p);
        }
    } else {
        // Spawn each configured server in its own task so a slow server
        // doesn't block the others. Each task lands its result into the
        // runtime under the lock and emits a fresh `McpStatus` carrying
        // the full per-server snapshot. Order of completion doesn't
        // matter — the UI reads the most-recent event as authoritative.
        for (idx, cfg) in mcp_servers_cfg.into_iter().enumerate() {
            let runtime_for_mcp = runtime.clone();
            let kc_path = kubeconfig_path.clone();
            let ctx = context_name.clone();
            let scratch_path = external_scratch.clone();
            tokio::spawn(async move {
                let outcome = async {
                    let proc_ = McpProcess::spawn(
                        &cfg,
                        kc_path.as_ref(),
                        Some(ctx.as_str()),
                        scratch_path.as_deref(),
                    )
                    .await?;
                    let tools = tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        proc_.client.list_tools(),
                    )
                    .await
                    .map_err(|_| {
                        McpProcessError::Initialize(ferrisscope_agent::McpError::InvalidResponse(
                            "tools/list timed out".into(),
                        ))
                    })?
                    .map_err(McpProcessError::Initialize)?;
                    Ok::<_, McpProcessError>((Arc::new(proc_), tools))
                }
                .await;

                let mut g = runtime_for_mcp.lock().await;
                if let Some(slot) = g.mcp_servers.get_mut(idx) {
                    match outcome {
                        Ok((proc_, tools)) => {
                            slot.process = Some(proc_);
                            slot.tools = tools;
                            slot.message = None;
                        }
                        Err(e) => {
                            slot.process = None;
                            slot.tools.clear();
                            slot.message = Some(e.to_string());
                        }
                    }
                }
                let snapshot = mcp_status_snapshot(&g);
                let _ = g.channel.send(snapshot);
            });
        }
    }

    let initial = initial_status_for_open(&runtime).await;
    let (context_limit, usable_context) =
        context_limits_for(data.meta.provider_kind, &data.meta.model);
    Ok(ChatOpenResult {
        chat_id,
        native_tool_count: initial.0,
        mcp_servers: initial.1,
        context_limit,
        usable_context,
    })
}

/// Snapshot the runtime's tool inventory for `chat_open`'s in-band
/// return value. Mirrors what `mcp_status_snapshot` builds for the
/// streaming `McpStatus` event but lifts the values out of the
/// `ChatEvent` enum so they can be serialised verbatim into
/// [`ChatOpenResult`].
async fn initial_status_for_open(
    runtime: &Arc<Mutex<ChatRuntime>>,
) -> (u32, Vec<McpServerStatusWire>) {
    let g = runtime.lock().await;
    #[allow(clippy::cast_possible_truncation)]
    let native_tool_count = g.native.tools().len() as u32;
    let servers = g
        .mcp_servers
        .iter()
        .map(|s| {
            #[allow(clippy::cast_possible_truncation)]
            let tool_count = s.tools.len() as u32;
            McpServerStatusWire {
                id: s.id.clone(),
                name: s.name.clone(),
                available: s.process.is_some(),
                tool_count,
                message: s.message.clone(),
            }
        })
        .collect();
    (native_tool_count, servers)
}

/// Build a per-server status snapshot from the live runtime. Used for both
/// the initial "everything pending" emit and the per-server-completed
/// updates. Caller must hold the runtime lock.
fn mcp_status_snapshot(g: &ChatRuntime) -> ChatEvent {
    #[allow(clippy::cast_possible_truncation)]
    let native_tool_count = g.native.tools().len() as u32;
    let servers = g
        .mcp_servers
        .iter()
        .map(|s| {
            #[allow(clippy::cast_possible_truncation)]
            let tool_count = s.tools.len() as u32;
            McpServerStatusWire {
                id: s.id.clone(),
                name: s.name.clone(),
                available: s.process.is_some(),
                tool_count,
                message: s.message.clone(),
            }
        })
        .collect();
    ChatEvent::McpStatus {
        servers,
        native_tool_count,
    }
}

async fn emit_mcp_status(runtime: &Arc<Mutex<ChatRuntime>>) {
    let g = runtime.lock().await;
    let evt = mcp_status_snapshot(&g);
    let _ = g.channel.send(evt);
}

#[tauri::command]
pub(crate) async fn chat_send_message(
    chat_id: String,
    content: String,
    view_context: Option<ViewContextWire>,
    // Image attachments (clipboard paste / file attach). `mime` + base64
    // `data`, no data-URL prefix. Persisted on the user message and turned
    // into provider-native image blocks for vision-capable models.
    images: Option<Vec<ImageAttachment>>,
    state: State<'_, AgentState>,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let runtime = {
        let chats = state.chats.lock().await;
        chats
            .get(&chat_id)
            .cloned()
            .ok_or_else(|| format!("chat not found: {chat_id}"))?
    };
    let store = state.store().await?;
    let p = load_persisted().await;
    // Pick the chat's provider from the persisted session meta, NOT the
    // currently-active global default — operators may have changed the
    // global default since the session was created. Old (pre-multi-
    // provider) sessions deserialised default to OpenRouter.
    let session_id_snapshot = runtime.lock().await.session_id.clone();
    let kind = match store.load(&session_id_snapshot).await {
        Ok(data) => data.meta.provider_kind,
        Err(_) => p.settings.active_provider,
    };
    let cred = effective_credential(kind)
        .await
        .ok_or_else(|| format!("no credential configured for provider {kind:?}"))?;
    let base_url = p
        .settings
        .providers
        .get(&kind)
        .and_then(|c| c.base_url.clone());
    let provider: Arc<dyn ChatProvider> = Arc::from(build_provider(
        kind,
        &cred,
        base_url,
        Some(session_id_snapshot.clone()),
        Some(make_credential_sink(kind)),
    )?);

    // Append the user message and decide whether to spawn a new turn or
    // hand off to the in-flight loop. Critical that the cancel-check and
    // append happen under one lock: if the loop is winding down it grabs
    // the lock to clear `cancel` and then re-checks for unanswered user
    // messages before exiting, so this critical section either lands
    // before the loop's check (loop picks up our message and re-runs) or
    // after (we see `cancel == None` and spawn fresh).
    let user_message = ChatMessage {
        role: MessageRole::User,
        content: content.clone(),
        tool_calls: vec![],
        tool_call_id: None,
        name: None,
        reasoning_content: None,
        images: images.unwrap_or_default(),
    };
    let (cluster_id, session_id, queue_only, title_snapshot) = {
        let mut rt = runtime.lock().await;
        rt.messages.push(user_message.clone());
        // Overwrite the stored snapshot every send so autocontinue / queued
        // sends use the most recent view. `None` payload clears the slot —
        // operators can disable the feature client-side by sending nothing.
        rt.last_view_context.clone_from(&view_context);
        let queue_only = rt.cancel.is_some();
        // Capture a once-per-chat snapshot for auto-titling under the
        // same lock so concurrent sends can't both fire the task.
        // The actual provider call runs outside this critical section.
        // `run_auto_title_task` separately bails if the persisted
        // title is already custom (manual rename, or a previous
        // successful auto-title on a now-reopened session).
        let snap = if rt.auto_title_done {
            None
        } else {
            snapshot_for_title(&rt.messages).map(|s| {
                rt.auto_title_done = true;
                (s, rt.model.clone())
            })
        };
        (
            rt.cluster_id.clone(),
            rt.session_id.clone(),
            queue_only,
            snap,
        )
    };
    if let Some((snap, model)) = title_snapshot {
        let provider_for_title = provider.clone();
        let store_for_title = store.clone();
        let runtime_for_title = runtime.clone();
        let cluster_for_title = cluster_id.clone();
        let session_for_title = session_id.clone();
        tauri::async_runtime::spawn(async move {
            run_auto_title_task(
                provider_for_title,
                store_for_title,
                runtime_for_title,
                cluster_for_title,
                session_for_title,
                snap,
                model,
            )
            .await;
        });
    }
    let now = chrono::Utc::now().timestamp_millis();
    let _ = store
        .append(
            &cluster_id,
            &session_id,
            SessionEvent::Message {
                message: user_message,
                ts: now,
            },
        )
        .await;

    if queue_only {
        // The running turn-loop will see this message at the top of its
        // next round (or, if it has already produced its final assistant
        // response, when it does its end-of-turn pending-message check).
        return Ok(());
    }

    // Pull the chat's cluster ctx so the system prompt can describe the
    // *active* cluster (which may differ from origin after a
    // `fs_configuration_use_context` call) instead of forcing the model
    // to spend a tool round-trip on `fs_configuration_view` to know
    // where it is.
    let (cluster_ctx, view_snapshot) = {
        let rt = runtime.lock().await;
        (rt.cluster.clone(), rt.last_view_context.clone())
    };
    let cluster_block = build_cluster_context_block(&cluster_ctx, &app_state).await;
    let active_cluster = cluster_ctx.active().await;
    let view_block =
        build_view_context_block(view_snapshot.as_ref(), &active_cluster, &app_state).await;
    let system_prompt = assemble_system_prompt(
        &cluster_block,
        &view_block,
        p.settings.system_prompt_override.as_deref(),
    );

    let runtime_clone = runtime.clone();
    let store_clone = store.clone();
    let cluster_id_clone = cluster_id.clone();
    let session_id_clone = session_id.clone();
    // OpenAI's Codex Responses endpoint rejects unknown top-level
    // params (`reasoning_effort` 400s); Chat Completions accepts
    // both. Pick the right shape based on credential type — OAuth
    // ⇒ Codex Responses, ApiKey ⇒ Chat Completions.
    let is_oauth = matches!(cred, Credential::OAuth { .. });
    let provider_options_default = resolve_provider_options(kind, &p.settings, is_oauth);

    let join = tokio::spawn(async move {
        run_turn_loop(
            runtime_clone,
            store_clone,
            provider,
            system_prompt,
            cluster_id_clone,
            session_id_clone,
            provider_options_default,
        )
        .await;
    });
    let abort = join.abort_handle();
    runtime.lock().await.cancel = Some(abort);
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_cancel_streaming(
    chat_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let chats = state.chats.lock().await;
    if let Some(rt) = chats.get(&chat_id) {
        let mut rt = rt.lock().await;
        if let Some(handle) = rt.cancel.take() {
            handle.abort();
            // The aborted task can't emit `AssistantEnd` itself — its
            // future is dropped. Close the bubble + flip the streaming
            // flag from here so the UI doesn't hang on a perpetual
            // caret. Drop a small in-bubble notice via TokenDelta first
            // so the operator sees "cancelled" as part of the existing
            // bubble rather than as a separate error pill below an empty
            // bubble. Pending approvals also get drained: their senders
            // dropping unwinds awaiting tool futures via Denied.
            if let Some(message_id) = rt.in_flight_message_id.take() {
                let _ = rt.channel.send(ChatEvent::TokenDelta {
                    delta: "\n\n_Cancelled by operator._".into(),
                });
                let _ = rt.channel.send(ChatEvent::AssistantEnd {
                    message_id,
                    finish_reason: FinishReason::Other,
                });
            }
            rt.pending_approvals.clear();
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_set_approval_mode(
    chat_id: String,
    mode: ApprovalMode,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id) else {
        return Err(format!("chat not found: {chat_id}"));
    };
    let (cluster_id, session_id) = {
        let mut g = rt.lock().await;
        g.approval_mode = mode;
        (g.cluster_id.clone(), g.session_id.clone())
    };
    drop(chats);
    let store = state.store().await?;
    let now = chrono::Utc::now().timestamp_millis();
    store
        .append(
            &cluster_id,
            &session_id,
            SessionEvent::SessionUpdate {
                update: SessionUpdate {
                    approval_mode: Some(mode),
                    ..Default::default()
                },
                ts: now,
            },
        )
        .await
        .map_err(session_err_to_string)
}

/// Re-emit the current `McpStatus` for this chat through its event
/// channel. The chat header's tools chip is driven by mcp_status events
/// alone; the backend only emits at chat_open time and on MCP-server
/// spawn results, so any UI flow that resets `view.mcp` (a remount, a
/// stale-state race) leaves the chip showing "…" or an out-of-date
/// count. The frontend pings this on tab-becomes-visible / settings
/// close so the chip is eventually-consistent with the live runtime.
#[tauri::command]
pub(crate) async fn chat_refresh_status(
    chat_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id).cloned() else {
        return Err(format!("chat not found: {chat_id}"));
    };
    drop(chats);
    emit_mcp_status(&rt).await;
    Ok(())
}

/// Switch the model used for this chat's next provider call. The
/// provider stays the same — model has to come from the session's
/// bound provider — and history is preserved. Updates the in-memory
/// runtime and journals a `SessionUpdate { model }` so reload picks
/// up the new id.
#[tauri::command]
pub(crate) async fn chat_set_model(
    chat_id: String,
    model: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Err("model id cannot be empty".to_string());
    }
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id) else {
        return Err(format!("chat not found: {chat_id}"));
    };
    // Pull the channel + cluster/session info out under the lock so the
    // post-update notification doesn't race a chat_close. `provider_kind`
    // is needed for the post-update ContextLimit event; reading it from
    // the runtime avoids a redundant `store.load`.
    let (cluster_id, session_id, channel, kind) = {
        let mut g = rt.lock().await;
        g.model = trimmed.to_string();
        (
            g.cluster_id.clone(),
            g.session_id.clone(),
            g.channel.clone(),
            g.provider_kind,
        )
    };
    drop(chats);
    let store = state.store().await?;
    let now = chrono::Utc::now().timestamp_millis();
    store
        .append(
            &cluster_id,
            &session_id,
            SessionEvent::SessionUpdate {
                update: SessionUpdate {
                    model: Some(trimmed.to_string()),
                    ..Default::default()
                },
                ts: now,
            },
        )
        .await
        .map_err(session_err_to_string)?;
    // Emit a ContextLimit event so the UI footer's `<used> / <limit>`
    // chip refreshes immediately on model swap, instead of waiting for
    // the next assistant turn to produce a Usage event with the new
    // limit folded in.
    let (context_limit, usable_context) = context_limits_for(kind, trimmed);
    let _ = channel.send(ChatEvent::ContextLimit {
        context_limit,
        usable_context,
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_list_tools(
    chat_id: String,
    state: State<'_, AgentState>,
) -> Result<Vec<ChatToolWire>, String> {
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id) else {
        return Err(format!("chat not found: {chat_id}"));
    };
    let g = rt.lock().await;
    let mut out: Vec<ChatToolWire> = Vec::new();
    for server in &g.mcp_servers {
        for tool in &server.tools {
            // A trusted server ("treat all as read") reports every tool as
            // read so the inspector matches what the approval gate will do.
            out.push(ChatToolWire {
                name: tool.name.clone(),
                description: tool.description.clone(),
                category: category_label(mcp_category(server.trust_as_read, &tool.name)),
                input_schema: tool.input_schema.clone(),
                source: server.name.clone(),
            });
        }
    }
    // Native tools come last, but otherwise look identical to MCP entries —
    // same wire shape so the inspector tree renders them with one code path.
    // We trust each tool's declared `category()` rather than re-running the
    // name heuristic, since native tools know their own kind exactly.
    for tool in g.native.tools() {
        let schema = tool.schema();
        out.push(ChatToolWire {
            name: schema.name,
            description: if schema.description.is_empty() {
                None
            } else {
                Some(schema.description)
            },
            category: category_label(tool.category()),
            input_schema: schema.parameters,
            source: "native".to_string(),
        });
    }
    Ok(out)
}

/// Manual compaction trigger. Operator clicks "Compact" in the chat
/// header; we fire a forced compaction outside the regular round
/// loop. Safe to call mid-streaming — `compaction_in_flight` and the
/// run-loop's per-round check serialise overlapping requests.
///
/// After a successful compaction, if the chat is **idle** (no in-flight
/// turn) and the last message is an Assistant turn, we inject a
/// synthetic "Continue from where you left off" user message and spawn
/// the loop. Mirrors opencode's `compaction_continue` autocontinue —
/// makes "Compact" mean "Compact and keep going" rather than "Compact
/// and stop". Manual compaction during an active turn skips the
/// autocontinue (the loop will pick up the post-compaction state on
/// its next round naturally).
#[tauri::command]
pub(crate) async fn chat_compact(
    chat_id: String,
    state: State<'_, AgentState>,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let runtime = {
        let chats = state.chats.lock().await;
        chats
            .get(&chat_id)
            .cloned()
            .ok_or_else(|| format!("chat not found: {chat_id}"))?
    };
    let store = state.store().await?;
    let p = load_persisted().await;
    let session_id = runtime.lock().await.session_id.clone();
    let kind = match store.load(&session_id).await {
        Ok(d) => d.meta.provider_kind,
        Err(_) => p.settings.active_provider,
    };
    let cred = effective_credential(kind)
        .await
        .ok_or_else(|| format!("no credential configured for provider {kind:?}"))?;
    let base_url = p
        .settings
        .providers
        .get(&kind)
        .and_then(|c| c.base_url.clone());
    let provider: Arc<dyn ChatProvider> = Arc::from(build_provider(
        kind,
        &cred,
        base_url,
        Some(session_id.clone()),
        Some(make_credential_sink(kind)),
    )?);
    let cluster_id = runtime.lock().await.cluster_id.clone();
    run_compaction_internal(&runtime, &store, &provider, &cluster_id, &session_id, true).await;
    autocontinue_if_idle(
        &runtime,
        &store,
        &provider,
        &cluster_id,
        &session_id,
        &app_state,
        &p,
        &cred,
        kind,
    )
    .await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_close(
    chat_id: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let removed = state.chats.lock().await.remove(&chat_id);
    if let Some(rt) = removed {
        close_chat_runtime(rt).await;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn chat_approve_tool_call(
    chat_id: String,
    tool_call_id: String,
    decision: ApprovalDecision,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let chats = state.chats.lock().await;
    let Some(rt) = chats.get(&chat_id) else {
        return Err(format!("chat not found: {chat_id}"));
    };
    let tx = {
        let mut g = rt.lock().await;
        g.pending_approvals.remove(&tool_call_id)
    };
    if let Some(tx) = tx {
        let _ = tx.send(decision);
        Ok(())
    } else {
        // No-op: the approval already resolved (chat closed, race) — let
        // the UI silently drop the click rather than surface a confusing
        // error.
        Ok(())
    }
}
