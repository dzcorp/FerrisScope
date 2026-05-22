// User bubbles render attached images as thumbnails, reconstructing the data
// URI from the wire {mime, data} pair. Image-only messages (no text) still
// render the grid.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";
import type { ChatViewMessage } from "./chatStreaming";

describe("MessageBubble — image attachments", () => {
  it("renders attached images as data-URI thumbnails", () => {
    const message: ChatViewMessage = {
      id: "m1",
      role: "user",
      content: "what is this?",
      images: [
        { mime: "image/png", data: "AAAA" },
        { mime: "image/jpeg", data: "Zm9v" },
      ],
    };
    const { container } = render(<MessageBubble mode="dark" message={message} />);
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(imgs[1]!.getAttribute("src")).toBe("data:image/jpeg;base64,Zm9v");
  });

  it("renders an image-only user message (no text)", () => {
    const message: ChatViewMessage = {
      id: "m2",
      role: "user",
      content: "",
      images: [{ mime: "image/webp", data: "YmFy" }],
    };
    const { container } = render(<MessageBubble mode="dark" message={message} />);
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("src")).toBe("data:image/webp;base64,YmFy");
  });

  it("renders no images for a plain user message", () => {
    const message: ChatViewMessage = {
      id: "m3",
      role: "user",
      content: "hello",
    };
    const { container } = render(<MessageBubble mode="dark" message={message} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});
