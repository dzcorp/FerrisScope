// The template catalogue is build-time data, but it's referenced by id from
// the dock — fat-fingering an id elsewhere becomes a runtime crash. Pin the
// shape so renames go through the test first.

import { describe, it, expect } from "vitest";
import jsYaml from "js-yaml";
import {
  DEFAULT_YAML_TEMPLATE_ID,
  getYamlTemplate,
  YAML_TEMPLATES,
  YAML_TEMPLATE_CATEGORIES,
} from "./yamlTemplates";

describe("YAML_TEMPLATES catalogue", () => {
  it("default id resolves to a real template", () => {
    const tpl = getYamlTemplate(DEFAULT_YAML_TEMPLATE_ID);
    expect(tpl.id).toBe(DEFAULT_YAML_TEMPLATE_ID);
    expect(tpl.kind).toBe("Deployment");
  });

  it("unknown id falls back to the default", () => {
    const fallback = getYamlTemplate("not-a-real-template");
    expect(fallback.id).toBe(DEFAULT_YAML_TEMPLATE_ID);
  });

  it("every template has a unique id", () => {
    const ids = YAML_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template's yaml parses cleanly and matches its declared kind", () => {
    for (const tpl of YAML_TEMPLATES) {
      const doc = jsYaml.load(tpl.yaml) as { kind?: string } | null;
      expect(doc).not.toBeNull();
      expect(doc!.kind).toBe(tpl.kind);
    }
  });

  it("every template belongs to a declared category", () => {
    const known = new Set(YAML_TEMPLATE_CATEGORIES);
    for (const tpl of YAML_TEMPLATES) {
      expect(known.has(tpl.category)).toBe(true);
    }
  });

  it("declared category list has no duplicates", () => {
    expect(new Set(YAML_TEMPLATE_CATEGORIES).size).toBe(
      YAML_TEMPLATE_CATEGORIES.length,
    );
  });
});
