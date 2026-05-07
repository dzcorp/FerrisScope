import { useEffect, useMemo, useRef, useState } from "react";
import { tokens, FONT_MONO, FONT_SANS, type ThemeMode } from "../../theme";
import type { ChatTool } from "../../types";
import type { McpStatus } from "./chatStreaming";

type Props = {
  mode: ThemeMode;
  tools: ChatTool[];
  mcp: McpStatus | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
};

// ToolsPopover — anchored under the Tools chip in ChatHeader. Two stacked
// blocks: a "Sources" header with one row per source (native + each MCP
// server, including failed/pending ones) and a tool list grouped by source
// then by Read/Write/Unknown within each source. Each tool row expands to
// show description + parameter list pulled from the tool's input schema.
export function ToolsPopover({
  mode,
  tools,
  mcp,
  loading,
  error,
  onClose,
}: Props) {
  const t = tokens(mode);
  const ref = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Build the list of sources to render — native always shown, even when
  // every MCP failed, because the chat is genuinely usable on native alone.
  // Order: native first, then MCP servers in operator-config order.
  //
  // Native count is derived from `tools` (the direct `chat_list_tools`
  // catalogue) rather than `mcp.nativeToolCount` so the row stays
  // accurate even if the streamed `mcp_status` snapshot is missing or
  // races to "0" — we already have the authoritative tool list right
  // here. MCP server rows still come from `mcp` because availability /
  // failure messages only live there.
  const sources = useMemo(() => {
    const rows: SourceRow[] = [];
    const nativeFromList = tools.filter((t) => t.source === "native").length;
    rows.push({
      kind: "native",
      key: "native",
      name: "Native (in-process)",
      available: true,
      toolCount: mcp?.nativeToolCount ?? nativeFromList,
      message: null,
    });
    for (const s of mcp?.servers ?? []) {
      rows.push({
        kind: "mcp",
        key: `mcp:${s.id}`,
        name: s.name,
        available: s.available,
        toolCount: s.tool_count,
        message: s.message,
      });
    }
    return rows;
  }, [mcp, tools]);

  // Filter + group tools by source name, then sort by category within each
  // source. Tools without a known source bucket end up in "Other" — defensive
  // fallback for older builds where `source` might be missing.
  const grouped = useMemo(() => {
    const norm = filter.trim().toLowerCase();
    const filtered = norm
      ? tools.filter(
          (tool) =>
            tool.name.toLowerCase().includes(norm) ||
            (tool.description ?? "").toLowerCase().includes(norm),
        )
      : tools;
    const bySource = new Map<string, ChatTool[]>();
    for (const tool of filtered) {
      const key = tool.source || "Other";
      const arr = bySource.get(key);
      if (arr) {
        arr.push(tool);
      } else {
        bySource.set(key, [tool]);
      }
    }
    for (const arr of bySource.values()) {
      arr.sort((a, b) => {
        if (a.category !== b.category) {
          return categoryRank(a.category) - categoryRank(b.category);
        }
        return a.name.localeCompare(b.name);
      });
    }
    return bySource;
  }, [tools, filter]);

  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });

  const totalShown = Array.from(grouped.values()).reduce(
    (acc, arr) => acc + arr.length,
    0,
  );

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        top: "100%",
        right: 12,
        marginTop: 6,
        width: 420,
        maxHeight: 480,
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        boxShadow: `0 6px 20px rgba(0,0,0,0.35)`,
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT_SANS,
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          borderBottom: `1px solid ${t.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ color: t.text, fontSize: 12, fontWeight: 600 }}>
          Tools
        </span>
        <span
          style={{
            color: t.textMuted,
            fontSize: 10.5,
            fontFamily: FONT_MONO,
          }}
        >
          {tools.length} available
        </span>
        <input
          autoFocus
          value={filter}
          placeholder="filter…"
          onChange={(e) => setFilter(e.target.value)}
          style={{
            marginLeft: "auto",
            width: 140,
            background: t.surfaceAlt,
            color: t.text,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 4,
            padding: "2px 6px",
            fontFamily: FONT_MONO,
            fontSize: 11,
            outline: "none",
          }}
        />
      </div>

      {/* Sources block — always shown so the operator knows native is
          live, and so failed / pending MCP servers surface their reason. */}
      <div
        style={{
          padding: "6px 10px 6px",
          borderBottom: `1px solid ${t.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontFamily: FONT_MONO,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: t.textDim,
          }}
        >
          Sources
        </div>
        {sources.map((s) => (
          <SourceRowView key={s.key} mode={mode} row={s} />
        ))}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "4px 0",
        }}
      >
        {loading && (
          <div
            style={{
              padding: "12px 10px",
              color: t.textMuted,
              fontSize: 11.5,
            }}
          >
            Loading tools…
          </div>
        )}
        {error && (
          <div
            style={{
              padding: "10px 12px",
              color: t.bad,
              fontSize: 11.5,
              fontFamily: FONT_MONO,
              wordBreak: "break-word",
            }}
          >
            {error}
          </div>
        )}
        {!loading && !error && tools.length === 0 && (
          <div
            style={{
              padding: "12px 10px",
              color: t.textMuted,
              fontSize: 11.5,
            }}
          >
            No tools available.
          </div>
        )}
        {!loading && !error && tools.length > 0 && totalShown === 0 && (
          <div
            style={{
              padding: "12px 10px",
              color: t.textMuted,
              fontSize: 11.5,
            }}
          >
            No tools match this filter.
          </div>
        )}
        {!loading &&
          !error &&
          totalShown > 0 &&
          // Render in source order from the sources list, then any leftover
          // groups (defensive: a tool whose `source` wasn't represented in
          // mcp_status — shouldn't happen, but render rather than swallow).
          renderSourceOrder(sources, grouped).map(([sourceName, toolList]) => (
            <SourceGroup
              key={sourceName}
              mode={mode}
              sourceName={sourceName}
              tools={toolList}
              expanded={expanded}
              onToggle={toggle}
            />
          ))}
      </div>
    </div>
  );
}

type SourceRow = {
  kind: "native" | "mcp";
  key: string;
  name: string;
  available: boolean;
  toolCount: number;
  message: string | null;
};

function SourceRowView({ mode, row }: { mode: ThemeMode; row: SourceRow }) {
  const t = tokens(mode);
  const dot = row.available ? t.good : row.message ? t.warn : t.info;
  const status = row.available
    ? `${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}`
    : row.message
      ? "failed"
      : "starting…";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11.5,
          color: t.text,
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: dot,
          }}
        />
        <span style={{ flex: 1 }}>{row.name}</span>
        <span style={{ color: t.textMuted, fontFamily: FONT_MONO, fontSize: 10.5 }}>
          {status}
        </span>
      </div>
      {row.message && (
        <div
          style={{
            paddingLeft: 12,
            color: t.warn,
            fontSize: 10.5,
            fontFamily: FONT_MONO,
            wordBreak: "break-word",
          }}
        >
          {row.message}
        </div>
      )}
    </div>
  );
}

function renderSourceOrder(
  sources: SourceRow[],
  grouped: Map<string, ChatTool[]>,
): Array<[string, ChatTool[]]> {
  const seen = new Set<string>();
  const out: Array<[string, ChatTool[]]> = [];
  for (const s of sources) {
    const sourceLabel = s.kind === "native" ? "native" : s.name;
    const arr = grouped.get(sourceLabel);
    if (arr && arr.length > 0) {
      out.push([s.kind === "native" ? "Native" : s.name, arr]);
      seen.add(sourceLabel);
    }
  }
  // Stragglers — anything in `grouped` that wasn't matched by a known source.
  for (const [k, v] of grouped) {
    if (!seen.has(k) && v.length > 0) {
      out.push([k, v]);
    }
  }
  return out;
}

function categoryRank(c: ChatTool["category"]): number {
  if (c === "read") return 0;
  if (c === "write") return 1;
  return 2;
}

function SourceGroup({
  mode,
  sourceName,
  tools,
  expanded,
  onToggle,
}: {
  mode: ThemeMode;
  sourceName: string;
  tools: ChatTool[];
  expanded: Set<string>;
  onToggle: (name: string) => void;
}) {
  const t = tokens(mode);
  return (
    <div>
      <div
        style={{
          padding: "8px 10px 2px",
          fontSize: 10,
          fontFamily: FONT_MONO,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: t.textDim,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span>{sourceName}</span>
        <span>({tools.length})</span>
      </div>
      {tools.map((tool) => (
        <ToolRow
          key={tool.name}
          mode={mode}
          tool={tool}
          open={expanded.has(tool.name)}
          onToggle={() => onToggle(tool.name)}
        />
      ))}
    </div>
  );
}

function ToolRow({
  mode,
  tool,
  open,
  onToggle,
}: {
  mode: ThemeMode;
  tool: ChatTool;
  open: boolean;
  onToggle: () => void;
}) {
  const t = tokens(mode);
  const params = useMemo(() => extractParams(tool.input_schema), [tool.input_schema]);
  const tagColor =
    tool.category === "read"
      ? t.good
      : tool.category === "write"
        ? t.warn
        : t.textMuted;
  return (
    <div
      style={{
        borderTop: `1px solid ${t.borderSoft}`,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: "6px 10px",
          cursor: "pointer",
          color: t.text,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            color: t.textDim,
            fontFamily: FONT_MONO,
            fontSize: 10,
            width: 8,
            display: "inline-block",
          }}
        >
          {open ? "▾" : "▸"}
        </span>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {tool.name}
        </span>
        <span
          style={{
            color: tagColor,
            fontFamily: FONT_MONO,
            fontSize: 9.5,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {tool.category}
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: "0 10px 8px 26px",
            color: t.textMuted,
            fontSize: 11,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {tool.description ? (
            <div style={{ whiteSpace: "pre-wrap", color: t.textMuted }}>
              {tool.description}
            </div>
          ) : (
            <div style={{ color: t.textDim, fontStyle: "italic" }}>
              No description provided.
            </div>
          )}
          {params.length > 0 && (
            <div
              style={{
                marginTop: 2,
                fontFamily: FONT_MONO,
                fontSize: 10.5,
                color: t.textMuted,
              }}
            >
              <div style={{ color: t.textDim, marginBottom: 2 }}>parameters</div>
              {params.map((p) => (
                <div key={p.name} style={{ display: "flex", gap: 6 }}>
                  <span style={{ color: t.text }}>{p.name}</span>
                  <span style={{ color: t.textDim }}>{p.type}</span>
                  {p.required && (
                    <span style={{ color: t.warn }}>required</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ParamRow = { name: string; type: string; required: boolean };

function extractParams(schema: unknown): ParamRow[] {
  if (!schema || typeof schema !== "object") return [];
  const obj = schema as Record<string, unknown>;
  const properties = obj.properties;
  if (!properties || typeof properties !== "object") return [];
  const required = Array.isArray(obj.required)
    ? new Set(obj.required.filter((s): s is string => typeof s === "string"))
    : new Set<string>();
  const rows: ParamRow[] = [];
  for (const [name, value] of Object.entries(
    properties as Record<string, unknown>,
  )) {
    const sub = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const type = (() => {
      const raw = sub.type;
      if (typeof raw === "string") return raw;
      if (Array.isArray(raw))
        return raw.filter((s): s is string => typeof s === "string").join("|");
      return "any";
    })();
    rows.push({ name, type, required: required.has(name) });
  }
  rows.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}
