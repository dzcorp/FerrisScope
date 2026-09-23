import type { ReactNode } from "react";
import { FS_SM, FS_XS, R_MD, type Tokens } from "../../../theme";

// Bordered, responsive table shell shared by the GitOps / Helm history and
// result lists. Columns use minmax so narrow panels shrink instead of overflow.
export function DataTable({
  t,
  label,
  columns,
  header,
  children,
}: {
  t: Tokens;
  label: string;
  columns: string;
  header: string[];
  children: ReactNode;
}) {
  return (
    <div
      role="table"
      aria-label={label}
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: R_MD,
        overflow: "hidden",
      }}
    >
      <div
        role="row"
        style={{
          display: "grid",
          gridTemplateColumns: columns,
          gap: 8,
          padding: "6px 12px",
          fontSize: FS_XS,
          fontWeight: 700,
          color: t.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          background: t.surfaceAlt,
          borderBottom: `1px solid ${t.border}`,
        }}
      >
        {header.map((h, i) => (
          <span key={i} role="columnheader" style={{ minWidth: 0 }}>
            {h}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}

export function DataRow({
  t,
  columns,
  highlight,
  children,
}: {
  t: Tokens;
  columns: string;
  highlight?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="row"
      style={{
        display: "grid",
        gridTemplateColumns: columns,
        gap: 8,
        alignItems: "center",
        padding: "7px 12px",
        fontSize: FS_SM,
        borderTop: `1px solid ${t.borderSoft}`,
        background: highlight ? t.accentSoft : undefined,
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

export function Cell({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      role="cell"
      title={title}
      style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
    >
      {children}
    </span>
  );
}
