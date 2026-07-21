import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom({ explode }: { explode: boolean }): ReactElement {
  if (explode) throw new Error("kaboom");
  return <div>alive</div>;
}

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary fallback={() => <div>fallback</div>}>
        <div>content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("content")).toBeTruthy();
    expect(screen.queryByText("fallback")).toBeNull();
  });

  it("shows the fallback (not a blank tree) and reports the error on a child throw", () => {
    // React logs the caught error to console.error; silence it so the test
    // output stays clean, and assert we forward it to onError instead.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <ErrorBoundary
        onError={onError}
        fallback={(err) => <div>caught: {err.message}</div>}
      >
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText("caught: kaboom")).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    spy.mockRestore();
  });

  it("a throwing onError never re-crashes the boundary", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary
        onError={() => {
          throw new Error("logger blew up");
        }}
        fallback={() => <div>still contained</div>}
      >
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText("still contained")).toBeTruthy();
    spy.mockRestore();
  });

  it("recovers when a fresh key remounts the boundary (the navigation reset path)", () => {
    // DetailPanel keys the boundary on object+tab, so navigating away remounts
    // it with a clean slate. Model that: a crashed boundary under one key gives
    // way to healthy children under a new key.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary key="a" fallback={() => <div>fallback</div>}>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fallback")).toBeTruthy();

    rerender(
      <ErrorBoundary key="b" fallback={() => <div>fallback</div>}>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("alive")).toBeTruthy();
    expect(screen.queryByText("fallback")).toBeNull();
    spy.mockRestore();
  });
});
