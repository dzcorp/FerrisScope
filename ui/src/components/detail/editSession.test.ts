import { describe, expect, it } from "vitest";
import { mergePatch } from "./editSession";

describe("mergePatch", () => {
  it("merges plain objects recursively", () => {
    const a = { spec: { replicas: 3, paused: false } };
    const b = { spec: { paused: true } };
    expect(mergePatch(a, b)).toEqual({ spec: { replicas: 3, paused: true } });
  });

  it("merges container arrays by name (env from one editor, mounts from another)", () => {
    const envPatch = {
      spec: {
        template: {
          spec: {
            containers: [
              { name: "main", env: [{ name: "FOO", value: "1" }] },
            ],
          },
        },
      },
    };
    const mountsPatch = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "main",
                volumeMounts: [{ name: "data", mountPath: "/data" }],
              },
            ],
          },
        },
      },
    };
    const merged = mergePatch(envPatch, mountsPatch) as Record<string, unknown>;
    const containers = (
      (merged.spec as Record<string, unknown>).template as Record<
        string,
        unknown
      >
    ).spec as { containers: { name: string; env?: unknown; volumeMounts?: unknown }[] };
    expect(containers.containers).toHaveLength(1);
    const c = containers.containers[0]!;
    expect(c.name).toBe("main");
    expect(c.env).toEqual([{ name: "FOO", value: "1" }]);
    expect(c.volumeMounts).toEqual([{ name: "data", mountPath: "/data" }]);
  });

  it("appends a new container when names don't overlap", () => {
    const a = {
      spec: {
        template: { spec: { containers: [{ name: "main", image: "x" }] } },
      },
    };
    const b = {
      spec: {
        template: { spec: { containers: [{ name: "side", image: "y" }] } },
      },
    };
    const merged = mergePatch(a, b) as {
      spec: { template: { spec: { containers: { name: string }[] } } };
    };
    expect(merged.spec.template.spec.containers.map((c) => c.name)).toEqual([
      "main",
      "side",
    ]);
  });

  it("merges env entries by name (later wins on overlap)", () => {
    const a = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "main",
                env: [
                  { name: "FOO", value: "old" },
                  { name: "BAR", value: "1" },
                ],
              },
            ],
          },
        },
      },
    };
    const b = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "main",
                env: [
                  { name: "FOO", value: "new" },
                  { name: "BAZ", value: "2" },
                ],
              },
            ],
          },
        },
      },
    };
    const merged = mergePatch(a, b) as {
      spec: {
        template: {
          spec: {
            containers: { env: { name: string; value: string }[] }[];
          };
        };
      };
    };
    const env = merged.spec.template.spec.containers[0]!.env;
    expect(env).toHaveLength(3);
    expect(env.find((e) => e.name === "FOO")?.value).toBe("new");
    expect(env.find((e) => e.name === "BAR")?.value).toBe("1");
    expect(env.find((e) => e.name === "BAZ")?.value).toBe("2");
  });

  it("merges volumeMounts by mountPath", () => {
    const a = {
      spec: {
        containers: [
          {
            name: "main",
            volumeMounts: [{ name: "data", mountPath: "/data" }],
          },
        ],
      },
    };
    const b = {
      spec: {
        containers: [
          {
            name: "main",
            volumeMounts: [{ name: "log", mountPath: "/log", readOnly: true }],
          },
        ],
      },
    };
    const merged = mergePatch(a, b) as {
      spec: {
        containers: {
          volumeMounts: { mountPath: string; readOnly?: boolean }[];
        }[];
      };
    };
    const mounts = merged.spec.containers[0]!.volumeMounts;
    expect(mounts.map((m) => m.mountPath)).toEqual(["/data", "/log"]);
    expect(mounts.find((m) => m.mountPath === "/log")?.readOnly).toBe(true);
  });

  it("replaces the value when types disagree", () => {
    expect(mergePatch({ x: 1 }, { x: "hello" })).toEqual({ x: "hello" });
    expect(mergePatch([1, 2], { foo: "bar" })).toEqual({ foo: "bar" });
  });

  it("replaces unknown arrays (no merge key)", () => {
    // `args` isn't in the listMap allowlist — last writer fully replaces.
    const a = { spec: { containers: [{ name: "c", args: ["--foo"] }] } };
    const b = { spec: { containers: [{ name: "c", args: ["--bar"] }] } };
    const merged = mergePatch(a, b) as {
      spec: { containers: { args: string[] }[] };
    };
    expect(merged.spec.containers[0]!.args).toEqual(["--bar"]);
  });
});
