import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTextEntryDefaults } from "./textEntry";

describe("installTextEntryDefaults", () => {
  let uninstall: () => void;
  beforeEach(() => {
    uninstall = installTextEntryDefaults();
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = "";
  });

  const mount = (html: string) => {
    document.body.innerHTML = html;
    const el = document.body.firstElementChild as HTMLElement;
    el.focus();
    return el;
  };

  const off = (el: HTMLElement) => [
    el.getAttribute("spellcheck"),
    el.getAttribute("autocorrect"),
    el.getAttribute("autocapitalize"),
    el.getAttribute("writingsuggestions"),
  ];

  it.each([
    "<input>",
    '<input type="search">',
    '<input type="password">',
    "<textarea></textarea>",
    '<div contenteditable="true" tabindex="0"></div>',
  ])("turns text services off on focus: %s", (html) => {
    expect(off(mount(html))).toEqual(["false", "off", "off", "false"]);
  });

  it("keeps an explicit spellcheck opt-in", () => {
    const el = mount('<textarea spellcheck="true"></textarea>');
    expect(off(el)).toEqual(["true", null, null, null]);
  });

  it("leaves non-text inputs alone", () => {
    const el = mount('<input type="checkbox">');
    expect(off(el)).toEqual([null, null, null, null]);
  });

  it("stops after uninstall", () => {
    uninstall();
    const el = mount("<input>");
    expect(off(el)).toEqual([null, null, null, null]);
  });
});
