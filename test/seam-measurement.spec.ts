import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { blendWeights, SkinBinding } from "../src/skin-conditioning.js";
import { formatSeamTrade, measureMultipartSeam } from "../src/seam-measurement.js";

const fixturePath = new URL("./fixtures/multipart-seam.json", import.meta.url);

async function fixture(): Promise<SkinBinding> {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  return SkinBinding.fromJSON({
    positions: raw.positions,
    partIds: raw.partIds,
    skinIndices: raw.skinIndices,
    skinWeights: raw.skinWeights,
    jointCount: raw.jointCount
  });
}

describe("multipart seam measurement", () => {
  it("rasterizes the complete 176-frame fixture sweep and derives trade text", async () => {
    const source = await fixture();
    const result = measureMultipartSeam(source, blendWeights(source, 1).binding);
    expect(result.frames).toBe(176);
    expect(result.dimensions).toEqual({ width: 256, height: 256 });
    expect(result.conditioned.backgroundThroughSplitPx).toBeLessThan(result.source.backgroundThroughSplitPx);
    expect(result.conditioned.creasePx).toBeGreaterThan(result.source.creasePx);
    expect(formatSeamTrade(result)).toContain(`${result.frames} frames`);
    expect(formatSeamTrade(result)).not.toMatch(/974|287|31,316|36,470/u);
  });

  it("changes the retained measurement when the fixture input changes", async () => {
    const source = await fixture();
    const mutated = new SkinBinding({
      ...source.toJSON(),
      positions: source.positions.map((point, index) => index === 4 ? [point[0] + 0.003, point[1], point[2]] : point)
    });
    const baseline = measureMultipartSeam(source, blendWeights(source, 1).binding);
    const changed = measureMultipartSeam(mutated, blendWeights(mutated, 1).binding);
    expect(changed.conditioned.backgroundThroughSplitPx).not.toBe(baseline.conditioned.backgroundThroughSplitPx);
  });
});
