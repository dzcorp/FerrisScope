import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import type { ReleaseNote, ReleaseNotesBundle } from "../types";
import {
  type Tokens,
  FF_MONO,
  FS_LG,
  FS_MD,
  FS_SM,
  FS_XS,
  R_SM,
} from "../theme";
import { Chip, ErrorBlock } from "./ui";
import {
  type ChangeGroupKey,
  type GroupedChange,
  groupChanges,
  totalChangeCount,
  versionRangeLabel,
} from "../lib/releaseNotes";

// Accent dot colour per group. Features lean "good" (green), fixes "info"
// (blue), everything else stays muted — keeps the panel readable at a glance
// without inventing new tokens.
function groupColor(t: Tokens, key: ChangeGroupKey): string {
  if (key === "features") return t.good;
  if (key === "fixes") return t.info;
  return t.textMuted;
}

// Build `https://github.com/<owner>/<repo>` from a release html_url so PR links
// don't hard-code the repo. Falls back to null when the URL is unexpected.
function repoBaseFromReleaseUrl(htmlUrl: string | undefined): string | null {
  if (!htmlUrl) return null;
  const m = htmlUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)/);
  return m && m[1] ? m[1] : null;
}

function PrLink({ t, repoBase, pr }: { t: Tokens; repoBase: string | null; pr: number }) {
  if (!repoBase) {
    return <span style={{ color: t.textMuted, fontFamily: FF_MONO, fontSize: FS_XS }}>#{pr}</span>;
  }
  return (
    <button
      type="button"
      title={`Open PR #${pr} on GitHub`}
      onClick={() => void openUrl(`${repoBase}/pull/${pr}`)}
      style={{
        background: "transparent",
        border: 0,
        padding: 0,
        cursor: "pointer",
        color: t.accent,
        fontFamily: FF_MONO,
        fontSize: FS_XS,
      }}
    >
      #{pr}
    </button>
  );
}

function ChangeRow({
  t,
  change,
  repoBase,
  showVersion,
}: {
  t: Tokens;
  change: GroupedChange;
  repoBase: string | null;
  showVersion?: boolean;
}) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        padding: "3px 0",
        fontSize: FS_MD,
        color: t.text,
        lineHeight: 1.45,
      }}
    >
      <span aria-hidden style={{ color: t.textMuted, flexShrink: 0 }}>
        •
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        {change.scope ? (
          <span style={{ color: t.textDim, fontFamily: FF_MONO }}>{change.scope}: </span>
        ) : null}
        {change.text}
      </span>
      {showVersion ? (
        <span style={{ color: t.textMuted, fontFamily: FF_MONO, fontSize: FS_XS, flexShrink: 0 }}>
          v{change.version}
        </span>
      ) : null}
      {change.pr != null ? (
        <span style={{ flexShrink: 0 }}>
          <PrLink t={t} repoBase={repoBase} pr={change.pr} />
        </span>
      ) : null}
    </li>
  );
}

// Merged view: every pending release folded into Features / Fixes / Other.
function MergedView({
  t,
  releases,
  repoBase,
  multi,
}: {
  t: Tokens;
  releases: ReleaseNote[];
  repoBase: string | null;
  multi: boolean;
}) {
  const groups = groupChanges(releases);
  if (groups.length === 0) {
    return (
      <div style={{ fontSize: FS_MD, color: t.textDim, marginTop: 8 }}>
        No detailed notes for these releases — open them on GitHub for the full changelog.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
      {groups.map((g) => (
        <div key={g.key}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: FS_SM,
              fontWeight: 600,
              color: t.textDim,
              marginBottom: 4,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 99,
                background: groupColor(t, g.key),
                flexShrink: 0,
              }}
            />
            {g.label}
            <span style={{ color: t.textMuted, fontWeight: 400 }}>({g.items.length})</span>
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {g.items.map((c, i) => (
              <ChangeRow
                key={`${c.version}-${c.pr ?? i}`}
                t={t}
                change={c}
                repoBase={repoBase}
                // Only worth showing the source version when several releases
                // are merged together.
                showVersion={multi}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// Per-version breakdown: one block per release, newest first.
function PerVersionView({
  t,
  releases,
  repoBase,
}: {
  t: Tokens;
  releases: ReleaseNote[];
  repoBase: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>
      {releases.map((rel) => (
        <div key={rel.tag}>
          <button
            type="button"
            title="Open this release on GitHub"
            onClick={() => void openUrl(rel.html_url)}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              background: "transparent",
              border: 0,
              padding: 0,
              cursor: "pointer",
              color: t.text,
              fontFamily: FF_MONO,
              fontSize: FS_MD,
              fontWeight: 600,
            }}
          >
            v{rel.version}
            {rel.published_at ? (
              <span style={{ color: t.textMuted, fontWeight: 400, fontSize: FS_XS }}>
                {rel.published_at.slice(0, 10)}
              </span>
            ) : null}
          </button>
          {rel.changes.length === 0 ? (
            <div style={{ fontSize: FS_SM, color: t.textMuted, marginTop: 2 }}>
              No detailed notes.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
              {rel.changes.map((c, i) => (
                <ChangeRow
                  key={c.pr ?? i}
                  t={t}
                  change={{ ...c, version: rel.version }}
                  repoBase={repoBase}
                />
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/// The About panel's dynamic "What's new" view. Owns its own fetch (the backend
/// caches + ETag-revalidates, so mounting is cheap) and renders the merged,
/// version-collapsed changelog for every release newer than the installed
/// build. Shows loading / empty / error states.
export function ReleaseNotes({
  t,
  reloadKey,
}: {
  t: Tokens;
  /// Force-refetch the notes when this value changes (skipping the freshness
  /// window). The About panel passes the latest version the update check found,
  /// so hitting its "Check for updates" button surfaces a just-published
  /// release here even if the 6h cache is still warm. The mount fetch is always
  /// cached — this only fires on subsequent changes.
  reloadKey?: string;
}) {
  const [bundle, setBundle] = useState<ReleaseNotesBundle | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");
  const [expanded, setExpanded] = useState(false);

  const load = useCallback((force: boolean) => {
    if (!force) setPhase("loading");
    api
      .getReleaseNotes(force)
      .then((b) => {
        setBundle(b);
        setPhase("ready");
      })
      .catch((e) => {
        setErrMsg(String(e));
        setPhase("error");
      });
  }, []);

  // Cached fetch on mount.
  useEffect(() => {
    load(false);
  }, [load]);

  // Force-refetch when the update check reports a different version. Skip the
  // first run — mount already did the cached load.
  const firstReload = useRef(true);
  useEffect(() => {
    if (firstReload.current) {
      firstReload.current = false;
      return;
    }
    load(true);
  }, [reloadKey, load]);

  const releases = bundle?.releases ?? [];
  const multi = releases.length > 1;
  const repoBase = repoBaseFromReleaseUrl(releases[0]?.html_url);

  return (
    <div data-fs-anchor="about-whatsnew" style={{ marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <div style={{ fontSize: FS_LG, fontWeight: 700, color: t.text }}>
          {phase === "ready" && releases.length > 0
            ? `What's new in ${versionRangeLabel(releases)}`
            : "What's new"}
        </div>
        {phase === "ready" && releases.length > 0 ? (
          <Chip t={t} tone="accent">
            {totalChangeCount(releases)} change
            {totalChangeCount(releases) === 1 ? "" : "s"}
          </Chip>
        ) : null}
      </div>

      {phase === "loading" ? (
        <div style={{ fontSize: FS_MD, color: t.textDim, marginTop: 12 }}>
          Loading release notes…
        </div>
      ) : null}

      {phase === "error" ? (
        <div style={{ marginTop: 12 }}>
          <ErrorBlock
            t={t}
            message={errMsg}
            kindLabel="release notes"
            verb="load"
            inline
          />
        </div>
      ) : null}

      {phase === "ready" && releases.length === 0 ? (
        <div style={{ fontSize: FS_MD, color: t.textDim, marginTop: 12 }}>
          You're on the latest version — no newer releases.
        </div>
      ) : null}

      {phase === "ready" && releases.length > 0 ? (
        <>
          {expanded ? (
            <PerVersionView t={t} releases={releases} repoBase={repoBase} />
          ) : (
            <MergedView t={t} releases={releases} repoBase={repoBase} multi={multi} />
          )}
          {multi ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                marginTop: 12,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "transparent",
                border: `1px solid ${t.border}`,
                borderRadius: R_SM,
                padding: "4px 10px",
                cursor: "pointer",
                color: t.textDim,
                fontSize: FS_SM,
              }}
            >
              {expanded ? "Show merged" : "Show per-version"}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
