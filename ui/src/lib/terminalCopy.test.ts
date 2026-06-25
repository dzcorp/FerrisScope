import { describe, expect, it } from "vitest";
import { normalizeTerminalSelection } from "./terminalCopy";

describe("normalizeTerminalSelection", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeTerminalSelection("")).toBe("");
  });

  it("strips a trailing newline (the shell auto-exec footgun)", () => {
    expect(normalizeTerminalSelection("kubectl get pods\n")).toBe(
      "kubectl get pods",
    );
  });

  it("collapses CRLF row separators to LF", () => {
    expect(normalizeTerminalSelection("line1\r\nline2\r\n")).toBe(
      "line1\nline2",
    );
  });

  it("collapses a lone CR (carriage-return redraw) to LF", () => {
    expect(normalizeTerminalSelection("a\rb")).toBe("a\nb");
  });

  it("preserves leading indentation of the first real line", () => {
    expect(normalizeTerminalSelection("  spec:\n    replicas: 3  ")).toBe(
      "  spec:\n    replicas: 3",
    );
  });

  it("drops leading blank lines but keeps internal ones", () => {
    expect(normalizeTerminalSelection("\n\nfirst\n\nsecond\n\n")).toBe(
      "first\n\nsecond",
    );
  });

  it("trims trailing spaces and tabs as well as newlines", () => {
    expect(normalizeTerminalSelection("text \t\n  \n")).toBe("text");
  });

  it("leaves already-clean multi-line text untouched", () => {
    expect(normalizeTerminalSelection("a\nb\nc")).toBe("a\nb\nc");
  });

  it("defaults to LF line endings", () => {
    expect(normalizeTerminalSelection("a\r\nb", "lf")).toBe("a\nb");
  });

  describe("eol: crlf (Windows)", () => {
    it("re-emits internal newlines as CRLF after trimming the trailing one", () => {
      expect(normalizeTerminalSelection("line1\r\nline2\r\n", "crlf")).toBe(
        "line1\r\nline2",
      );
    });

    it("normalises lone CR to CRLF", () => {
      expect(normalizeTerminalSelection("a\rb", "crlf")).toBe("a\r\nb");
    });

    it("preserves internal blank lines as CRLF", () => {
      expect(normalizeTerminalSelection("a\n\nb", "crlf")).toBe("a\r\n\r\nb");
    });

    it("single-line copy carries no line ending", () => {
      expect(normalizeTerminalSelection("kubectl get pods\n", "crlf")).toBe(
        "kubectl get pods",
      );
    });
  });
});
