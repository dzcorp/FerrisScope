const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "password"]);
const EDITABLE = new Set(["", "true", "plaintext-only"]);

function isTextEntry(el: EventTarget | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type);
  return el instanceof HTMLElement && EDITABLE.has(el.getAttribute("contenteditable") ?? "-");
}

/// The webview inherits OS text services (macOS WKWebView autocorrects "pmm" to
/// "Mmm"; WebView2 squiggles names). Fields here take identifiers, so focus
/// turns them off unless the element sets `spellcheck` itself.
export function installTextEntryDefaults(doc: Document = document): () => void {
  const onFocus = (e: FocusEvent) => {
    const el = e.target;
    if (!isTextEntry(el) || el.hasAttribute("spellcheck")) return;
    el.setAttribute("spellcheck", "false");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("writingsuggestions", "false");
  };
  doc.addEventListener("focusin", onFocus, true);
  return () => doc.removeEventListener("focusin", onFocus, true);
}
