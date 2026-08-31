import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  findGrimoirePage,
  loadGrimoireCatalog,
  resourceSafetyReason
} from "../src/grimoire.js";

describe("technique-safe grimoire", () => {
  it("retains every upstream file while filtering unsafe served content", async () => {
    const catalog = await loadGrimoireCatalog();
    expect(catalog.pages.length + catalog.rejected.length).toBe(35);
    expect(catalog.pages.length).toBe(31);
    expect(catalog.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: "character/structure_decomposition" }),
        expect.objectContaining({ topic: "build/threejs_texture_reference" }),
        expect.objectContaining({ topic: "build/threejs_skin_and_cloth_materials" })
      ])
    );
    const retained = await readFile("grimoire/character/structure_decomposition.md", "utf8");
    expect(retained).toContain("```glsl");
  });

  it("rejects a retained concrete shader page instead of returning it", async () => {
    const catalog = await loadGrimoireCatalog();
    expect(() => findGrimoirePage(catalog, "character/structure_decomposition")).toThrow(
      "retained but cannot be served"
    );
  });

  it("returns safe technique pages and lists valid topics on unknown input", async () => {
    const catalog = await loadGrimoireCatalog();
    expect(findGrimoirePage(catalog, "intake/quality_contract").text).toContain(
      "Quality Contract"
    );
    expect(() => findGrimoirePage(catalog, "not-a-topic")).toThrow(
      /Valid topics: .*intake\/quality_contract/
    );
  });

  it("detects fenced material construction code", () => {
    expect(resourceSafetyReason("```js\nnew THREE.MeshStandardMaterial({ roughness: 0.2 })\n```"))
      .toContain("material recipe");
  });
});

