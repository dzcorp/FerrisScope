import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CONFIGMAP_STORAGE_NOTICE, HelmStorageNotice } from "./storage";
import { tokens } from "../../../theme";
import { resetMockInvoke, setMockInvoke } from "../../../test/tauri-mock";

const t = tokens("light");

afterEach(() => {
  cleanup();
  resetMockInvoke();
});

describe("HelmStorageNotice", () => {
  it("warns when any cluster has ConfigMap-stored releases", async () => {
    const probed: unknown[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd !== "helm_storage_probe_cmd") throw new Error(cmd);
      probed.push(args?.clusterId);
      return args?.clusterId === "b";
    });
    render(<HelmStorageNotice t={t} clusterIds={["a", "b"]} />);
    expect(await screen.findByText(CONFIGMAP_STORAGE_NOTICE)).toBeInTheDocument();
    expect(probed).toEqual(["a", "b"]);
  });

  it("stays silent when nothing is found or the probe is forbidden", async () => {
    setMockInvoke((_, args) => {
      if (args?.clusterId === "denied") throw new Error("403 forbidden");
      return false;
    });
    render(<HelmStorageNotice t={t} clusterIds={["a", "denied"]} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(CONFIGMAP_STORAGE_NOTICE)).toBeNull();
  });
});
