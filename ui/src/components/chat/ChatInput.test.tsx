// ChatInput clipboard-image flow: pasting an image surfaces a thumbnail,
// Send forwards it as a base64 {mime, data} attachment alongside the text,
// and the remove badge drops it before send. Text-only paste is left to the
// browser's default (we don't intercept it).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatInput } from "./ChatInput";
import { setMockInvoke, resetMockInvoke } from "../../test/tauri-mock";
import type { ChatImageAttachment } from "../../types";

beforeEach(() => {
  resetMockInvoke();
  // Default: the native clipboard has no image. Tests that exercise the
  // WebKitGTK fallback override this.
  setMockInvoke((cmd) => (cmd === "read_clipboard_image" ? null : undefined));
});

function renderInput(
  overrides: Partial<React.ComponentProps<typeof ChatInput>> = {},
) {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(
    <ChatInput
      mode="dark"
      disabled={false}
      streaming={false}
      approvalMode="approve_per_write"
      onApprovalModeChange={() => {}}
      {...overrides}
      onSend={onSend}
      onCancel={onCancel}
    />,
  );
  return { onSend, onCancel };
}

// "hi" → base64 "aGk=", which is what jsdom's FileReader.readAsDataURL emits.
function pngFile(name = "shot.png") {
  return new File(["hi"], name, { type: "image/png" });
}

function pasteImage(file: File) {
  const textarea = screen.getByRole("textbox");
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    },
  });
}

describe("ChatInput — clipboard image attachments", () => {
  it("pastes an image, shows a thumbnail, and sends it with the text", async () => {
    const { onSend } = renderInput();
    pasteImage(pngFile());

    // Thumbnail appears once the FileReader resolves.
    const thumb = await screen.findByAltText("shot.png");
    expect(thumb.getAttribute("src")).toBe("data:image/png;base64,aGk=");

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "what is this?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, images] = onSend.mock.calls[0] as [
      string,
      ChatImageAttachment[],
    ];
    expect(text).toBe("what is this?");
    expect(images).toEqual([{ mime: "image/png", data: "aGk=" }]);
  });

  it("allows sending an image with no text", async () => {
    const { onSend } = renderInput();
    pasteImage(pngFile());
    await screen.findByAltText("shot.png");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, images] = onSend.mock.calls[0] as [
      string,
      ChatImageAttachment[],
    ];
    expect(text).toBe("");
    expect(images).toHaveLength(1);
  });

  it("removes a pasted image before sending", async () => {
    const { onSend } = renderInput();
    pasteImage(pngFile());
    await screen.findByAltText("shot.png");

    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    await waitFor(() =>
      expect(screen.queryByAltText("shot.png")).toBeNull(),
    );

    // With no text and no images, Send is disabled — nothing to send.
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("ignores a text paste (no thumbnail, no native read)", () => {
    const readImage = vi.fn(() => null);
    setMockInvoke((cmd) =>
      cmd === "read_clipboard_image" ? readImage() : undefined,
    );
    const { onSend } = renderInput();
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
        getData: (t: string) => (t === "text/plain" ? "kubectl get pods" : ""),
      },
    });
    // Text present → default textarea paste, never the native image fallback.
    expect(readImage).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows a Stop button while streaming and cancels on click", () => {
    const { onCancel } = renderInput({ streaming: true });
    // Nothing typed → no send/queue button, just Stop.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("queues a typed message while streaming", () => {
    const { onSend } = renderInput({ streaming: true });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "and also scale it" },
    });
    // Mid-stream the action button queues rather than sends.
    fireEvent.click(
      screen.getByRole("button", { name: "Queue for the next round" }),
    );
    expect(onSend).toHaveBeenCalledTimes(1);
    expect((onSend.mock.calls[0] as [string])[0]).toBe("and also scale it");
  });

  it("disables Send when the composer is empty", () => {
    renderInput();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("reads from the native clipboard when the webview hides the image (WebKitGTK)", async () => {
    setMockInvoke((cmd) =>
      cmd === "read_clipboard_image"
        ? ({ mime: "image/png", data: "aGk=" } satisfies ChatImageAttachment)
        : undefined,
    );
    const { onSend } = renderInput();
    // The WebKitGTK shape: no image File on the event, and no text either.
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { items: [], getData: () => "" },
    });

    const thumb = await screen.findByAltText("pasted image");
    expect(thumb.getAttribute("src")).toBe("data:image/png;base64,aGk=");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const [, images] = onSend.mock.calls[0] as [string, ChatImageAttachment[]];
    expect(images).toEqual([{ mime: "image/png", data: "aGk=" }]);
  });
});
