// Makes Monaco's Cut/Copy/Paste work on Linux Tauri (webkit2gtk).
//
// Two paths need fixing because Monaco routes them differently in
// "web mode" (which Tauri reports):
//
//   1. Keyboard Ctrl+C/X/V — Monaco's built-in `PasteAction` does NOT
//      register a keybinding when `isNative` is false (see
//      `editor/contrib/clipboard/browser/clipboard.js`). The browser's
//      native shortcut fires a DOM clipboard event on the editor's
//      hidden textarea, and Monaco reads `event.clipboardData` from
//      there. On webkit2gtk that data is empty when another OS app owns
//      the clipboard, so paste silently no-ops. We bind the shortcuts
//      ourselves with `editor.addAction` (no `contextMenuGroupId` so we
//      don't append duplicate menu entries) and read via Tauri.
//
//   2. Right-click Cut/Copy/Paste menu — Monaco invokes its
//      `editor.action.clipboardPasteAction` command. The `code-editor`
//      implementation under web mode calls `clipboardService.readText()`
//      which ultimately hits `navigator.clipboard.readText()`. We patch
//      `navigator.clipboard.{readText,writeText}` once at module load so
//      that path goes through `tauri-plugin-clipboard-manager`
//      (native, talks to GTK directly via arboard).
//
// `addAction` registers commands under `${editorId};${id}`, so the
// keyboard binding does NOT redirect the menu items — that's why the
// patch is required even with the `addAction` overrides in place.

import {
  readText as tauriReadText,
  writeText as tauriWriteText,
} from "@tauri-apps/plugin-clipboard-manager";
import type Editor from "@monaco-editor/react";

type OnMount = NonNullable<React.ComponentProps<typeof Editor>["onMount"]>;
export type MonacoEditor = Parameters<OnMount>[0];
export type MonacoNs = Parameters<OnMount>[1];

let patched = false;

function patchSystemClipboard() {
  if (patched) return;
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  patched = true;

  // Replace `navigator.clipboard` wholesale with a Proxy that intercepts
  // `readText` / `writeText` calls. We tried (a) `Object.defineProperty`
  // on the instance and (b) prototype mutation — both are unreliable on
  // webkit2gtk (Monaco's `BrowserClipboardService.readText` keeps
  // reaching the original native binding). A Proxy guarantees that any
  // property lookup on `navigator.clipboard` is intercepted, regardless
  // of whether the original binding lives on the instance, the
  // prototype, or some non-writable internal slot.
  const original = navigator.clipboard;
  const proxied = new Proxy(original, {
    get(target, prop, receiver) {
      if (prop === "readText") {
        return async function patchedReadText() {
          try {
            const text = await tauriReadText();
            return text ?? "";
          } catch {
            try {
              const fn = Reflect.get(target, prop, target) as
                | (() => Promise<string>)
                | undefined;
              return fn ? await fn.call(target) : "";
            } catch {
              return "";
            }
          }
        };
      }
      if (prop === "writeText") {
        return async function patchedWriteText(text: string) {
          try {
            await tauriWriteText(text);
            return;
          } catch {
            const fn = Reflect.get(target, prop, target) as
              | ((t: string) => Promise<void>)
              | undefined;
            if (fn) await fn.call(target, text);
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      get: () => proxied,
    });
  } catch {
    // Some webview builds disallow redefining `navigator.clipboard`.
    // The keyboard path still works via `addAction` below.
  }
}

patchSystemClipboard();

async function readClipboard(): Promise<string> {
  try {
    const text = await tauriReadText();
    return text ?? "";
  } catch {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      try {
        return await navigator.clipboard.readText();
      } catch {
        // Fall through.
      }
    }
    return "";
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await tauriWriteText(text);
    return true;
  } catch {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through.
      }
    }
    return false;
  }
}

export function installClipboardShortcuts(
  editor: MonacoEditor,
  monaco: MonacoNs,
) {
  patchSystemClipboard();

  const KeyMod = monaco.KeyMod;
  const KeyCode = monaco.KeyCode;
  const getSelectionText = () => {
    const sel = editor.getSelection();
    const model = editor.getModel();
    if (!sel || !model) return "";
    if (sel.isEmpty()) {
      const line = model.getLineContent(sel.startLineNumber);
      return `${line}\n`;
    }
    return model.getValueInRange(sel);
  };

  // Bind shortcuts WITHOUT `contextMenuGroupId` so we don't append
  // duplicate entries — the right-click menu keeps Monaco's built-in
  // items, which now route through our patched navigator.clipboard.

  editor.addAction({
    id: "ferrisscope.clipboardCopy",
    label: "Copy",
    keybindings: [KeyMod.CtrlCmd | KeyCode.KeyC],
    run: () => {
      void writeClipboard(getSelectionText());
    },
  });

  editor.addAction({
    id: "ferrisscope.clipboardCut",
    label: "Cut",
    keybindings: [KeyMod.CtrlCmd | KeyCode.KeyX],
    precondition: "!editorReadonly",
    run: async () => {
      const text = getSelectionText();
      const ok = await writeClipboard(text);
      if (!ok) return;
      const sel = editor.getSelection();
      const model = editor.getModel();
      if (!sel || !model) return;
      const range = sel.isEmpty()
        ? sel.startLineNumber < model.getLineCount()
          ? new monaco.Range(
              sel.startLineNumber,
              1,
              sel.startLineNumber + 1,
              1,
            )
          : new monaco.Range(
              sel.startLineNumber,
              1,
              sel.startLineNumber,
              model.getLineMaxColumn(sel.startLineNumber),
            )
        : sel;
      editor.executeEdits("ferrisscope.clipboardCut", [
        { range, text: "", forceMoveMarkers: true },
      ]);
    },
  });

  editor.addAction({
    id: "ferrisscope.clipboardPaste",
    label: "Paste",
    keybindings: [KeyMod.CtrlCmd | KeyCode.KeyV],
    precondition: "!editorReadonly",
    run: async () => {
      const text = await readClipboard();
      if (!text) return;
      const sel = editor.getSelection();
      if (!sel) return;
      editor.executeEdits("ferrisscope.clipboardPaste", [
        { range: sel, text, forceMoveMarkers: true },
      ]);
    },
  });
}
