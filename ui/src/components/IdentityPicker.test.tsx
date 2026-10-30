import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { tokens } from "../theme";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { IdentityPicker } from "./IdentityPicker";

const t = tokens("dark");
const OFFER = { noun: "profile", effects: ["set AWS_PROFILE"] };

beforeEach(() => {
  resetMockInvoke();
});

describe("IdentityPicker", () => {
  it("renders nothing with no identities to offer", () => {
    const { container } = render(
      <IdentityPicker
        t={t}
        contextId="default::eks"
        identities={[]}
        pinned={null}
        suggested={null}
        offer={OFFER}
        onPinned={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("won't re-pin the identity already pinned", () => {
    render(
      <IdentityPicker
        t={t}
        contextId="default::eks"
        identities={["dev"]}
        pinned="dev"
        suggested={null}
        offer={OFFER}
        onPinned={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /^pin profile$/i })).toBeDisabled();
  });

  it("keeps the picker and shows the error when the pin fails", async () => {
    setMockInvoke(() => {
      throw new Error("user 'u' is shared");
    });
    const onPinned = vi.fn();
    render(
      <IdentityPicker
        t={t}
        contextId="default::eks"
        identities={["dev", "prod"]}
        pinned="dev"
        suggested="prod"
        offer={OFFER}
        onPinned={onPinned}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^pin profile$/i }));
    expect(screen.getByText("set AWS_PROFILE")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^pin prod$/i }));
    await waitFor(() =>
      expect(screen.getByText(/user 'u' is shared/)).toBeInTheDocument(),
    );
    expect(onPinned).not.toHaveBeenCalled();
  });
});
