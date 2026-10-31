import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { LiveResourcesEditor, ResourcesEditor } from "./shared";
import { useAppStore } from "../../../store";
import { setMockInvoke, resetMockInvoke } from "../../../test/tauri-mock";
import type { MetricsSnapshot } from "../../../types";
import { EditSessionProvider } from "../editSession";
import { tokens } from "../../../theme";

const t = tokens("dark");
const TARGET = { clusterId: "c", kindId: "pods", namespace: "prod", name: "web" };

function editor(usage?: { cpu_milli: number; mem_mib: number } | null) {
  return render(
    <EditSessionProvider target={TARGET} onSaved={() => {}}>
      <ResourcesEditor
        t={t}
        containerName="app"
        containerKind="main"
        requests={{ cpu: "200m" }}
        limits={{ memory: "512Mi" }}
        serializeFor={() => ({})}
        usage={usage}
      />
    </EditSessionProvider>,
  );
}

describe("ResourcesEditor usage", () => {
  it("shows the container's usage beside its request and limit", () => {
    const text = editor({ cpu_milli: 50, mem_mib: 128 }).container.textContent ?? "";
    expect(text).toContain("50m used (25%)");
    expect(text).toContain("128Mi used (25%)");
  });

  it("renders the plain values without usage", () => {
    expect(editor().container.textContent).not.toContain("used");
  });
});

describe("LiveResourcesEditor", () => {
  beforeEach(() => {
    resetMockInvoke();
    useAppStore.setState({
      metricsByCluster: { c: { fetched_at_unix_ms: 1 } as unknown as MetricsSnapshot },
    });
  });

  it("reads its own container's usage for the pod", async () => {
    const asked: unknown[] = [];
    setMockInvoke((_cmd, args) => {
      asked.push(args);
      return [
        { name: "app", cpu_milli: 100, mem_mib: 1 },
        { name: "proxy", cpu_milli: 7, mem_mib: 1 },
      ];
    });
    const { container } = render(
      <EditSessionProvider target={TARGET} onSaved={() => {}}>
        <LiveResourcesEditor
          clusterId="c"
          namespace="prod"
          podName="web"
          t={t}
          containerName="app"
          containerKind="main"
          requests={{ cpu: "200m" }}
          limits={null}
          serializeFor={() => ({})}
        />
      </EditSessionProvider>,
    );
    await waitFor(() => expect(container.textContent).toContain("100m used (50%)"));
    expect(asked).toEqual([{ clusterId: "c", namespace: "prod", name: "web" }]);
  });
});
