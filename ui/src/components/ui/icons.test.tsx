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

  it("draws the AI chat glyph as a bubble with a sparkle cut out of it", () => {
    const svg = renderToStaticMarkup(Icons.chat);
    // Even-odd fill: the second subpath (the four-point sparkle) is a hole in
    // the bubble, not a second shape painted over it.
    expect(svg).toContain('fill-rule="evenodd"');
    const d = /d="([^"]+)"/.exec(svg)![1]!;
    expect(d.match(/[Mm]/g)).toHaveLength(2);
    // Bubble tail + sparkle are one path: nothing else is drawn.
    expect(svg.match(/<path/g)).toHaveLength(1);
  });
});
