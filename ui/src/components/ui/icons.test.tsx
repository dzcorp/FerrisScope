import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CrdIcons, Icons, KindIcons } from "./icons";

const all = [
  ...Object.entries(Icons),
  ...Object.entries(KindIcons),
  ...Object.entries(CrdIcons),
].map(([name, el]) => [name, renderToStaticMarkup(el)] as const);

describe("icon set", () => {
  it("paints only currentColor, so the caller's tone (danger, muted…) applies", () => {
    const offenders = all
      .filter(([, svg]) =>
        /(fill|stroke)="(?!currentColor")/.test(
          svg.replace(/(fill|clip)-rule/g, ""),
        ),
      )
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("draws every glyph in the shared 24×24 box", () => {
    const off = all
      .filter(([, svg]) => !svg.includes('viewBox="0 0 24 24"'))
      .map(([name]) => name);
    expect(off).toEqual([]);
  });

  it("gives every kind glyph its own silhouette", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [name, el] of [
      ...Object.entries(KindIcons),
      ...Object.entries(CrdIcons),
    ]) {
      const body = renderToStaticMarkup(el).replace(/<svg[^>]*>|<\/svg>/g, "");
      const prev = seen.get(body);
      if (prev) dupes.push(`${prev} = ${name}`);
      else seen.set(body, name);
    }
    expect(dupes).toEqual([]);
  });
});
