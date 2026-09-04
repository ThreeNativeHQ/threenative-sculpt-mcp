import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BLEND_RADIUS,
  CELL_OFFSETS,
  MAX_INFLUENCES,
  WEIGHT_SUM_TOLERANCE,
  SkinBinding,
  UniformGrid,
  blendWeights,
  bruteForceQuery,
  validateBinding,
  weldCoincident
} from "../src/skin-conditioning.js";

const fixturePath = new URL("./fixtures/multipart-seam.json", import.meta.url);

async function readFixtureBinding(): Promise<SkinBinding> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  return SkinBinding.fromJSON({
    positions: fixture.positions,
    partIds: fixture.partIds,
    skinIndices: fixture.skinIndices,
    skinWeights: fixture.skinWeights,
    jointCount: fixture.jointCount
  });
}

function rotateAboutZ(degrees: number, pivot: [number, number, number]) {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return (point: [number, number, number]): [number, number, number] => {
    const x = point[0] - pivot[0];
    const y = point[1] - pivot[1];
    return [cosine * x - sine * y + pivot[0], sine * x + cosine * y + pivot[1], point[2]];
  };
}

function pose(binding: SkinBinding, transforms: Array<(point: [number, number, number]) => [number, number, number]>, index: number) {
  const point = binding.positions[index]!;
  return binding.influences(index).reduce<[number, number, number]>(
    (result, [joint, weight]) => {
      if (weight === 0) return result;
      const moved = transforms[joint]!(point);
      return [
        result[0] + weight * moved[0],
        result[1] + weight * moved[1],
        result[2] + weight * moved[2]
      ];
    },
    [0, 0, 0]
  );
}

describe("skin conditioning", () => {
  it("closes the multipart seam while retaining the crease trade report", async () => {
    const source = await readFixtureBinding();
    const result = blendWeights(source, 1);
    const seamA = 4;
    const seamB = 6;
    const transforms = [
      (point: [number, number, number]) => point,
      rotateAboutZ(40, [0, -0.4, 0])
    ];
    const before = Math.hypot(
      ...pose(source, transforms, seamA).map((value, axis) => value - pose(source, transforms, seamB)[axis]!)
    );
    const after = Math.hypot(
      ...pose(result.binding, transforms, seamA).map((value, axis) => value - pose(result.binding, transforms, seamB)[axis]!)
    );
    expect(before).toBeGreaterThan(0.2);
    expect(after).toBeLessThan(before * 0.01);
    expect(result.report.verticesTouched).toBeGreaterThan(0);
    expect(result.report.trade).toContain("creases");
    expect(result.report.residual).toContain("not eliminated");
    expect(validateBinding(result.binding)).toEqual([]);
  });

  it("uses a dense neighborhood, reports top-four loss, and does not mutate input", () => {
    const positions: [number, number, number][] = [[0, 0, 0]];
    const partIds = ["a"];
    const skinIndices = [0, 1, 0, 0];
    const skinWeights = [0.7, 0.3, 0, 0];
    for (const [offset, joint] of [[0.001, 2], [0.0015, 3], [0.002, 4], [0.0025, 5]] as const) {
      positions.push([offset, 0, 0]);
      partIds.push("b");
      skinIndices.push(joint, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0);
    }
    const source = new SkinBinding({ positions, partIds, skinIndices, skinWeights, jointCount: 6 });
    const original = source.toJSON();
    const result = blendWeights(source, 1);
    expect(new Set(result.binding.skinIndices.slice(0, MAX_INFLUENCES))).toEqual(new Set([0, 2, 3, 4]));
    expect(result.report.maxInfluencesSeen).toBeGreaterThan(MAX_INFLUENCES);
    expect(result.report.lossyReductions).toBeGreaterThan(0);
    expect(result.report.maxDiscardedFraction).toBeGreaterThan(0);
    expect(source.toJSON()).toEqual(original);
  });

  it("marks a top-four reduction above the report threshold as unsafe", () => {
    const source = new SkinBinding({
      positions: [[0, 0, 0], [0.001, 0, 0], [0.0015, 0, 0], [0.002, 0, 0], [0.0025, 0, 0]],
      partIds: ["a", "b", "b", "b", "b"],
      skinIndices: [0, 1, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0],
      skinWeights: [0.7, 0.3, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      jointCount: 6
    });
    const result = blendWeights(source, 1);
    expect(result.report.maxDiscardedFraction).toBeGreaterThan(result.report.discardThreshold);
    expect(result.report.lossyReductions).toBeGreaterThan(0);
  });

  it("is independent of vertex order and leaves interior vertices bit-identical", async () => {
    const source = await readFixtureBinding();
    const order = [...Array(source.vertexCount).keys()].reverse();
    const shuffled = new SkinBinding({
      positions: order.map((index) => source.positions[index]!),
      partIds: order.map((index) => source.partIds[index]),
      skinIndices: order.flatMap((index) => source.skinIndices.slice(index * MAX_INFLUENCES, index * MAX_INFLUENCES + MAX_INFLUENCES)),
      skinWeights: order.flatMap((index) => source.skinWeights.slice(index * MAX_INFLUENCES, index * MAX_INFLUENCES + MAX_INFLUENCES)),
      jointCount: source.jointCount
    });
    const straight = blendWeights(source, 1).binding;
    const mixed = blendWeights(shuffled, 1).binding;
    order.forEach((original, position) => {
      expect(mixed.skinIndices.slice(position * MAX_INFLUENCES, position * MAX_INFLUENCES + MAX_INFLUENCES)).toEqual(
        straight.skinIndices.slice(original * MAX_INFLUENCES, original * MAX_INFLUENCES + MAX_INFLUENCES)
      );
      expect(mixed.skinWeights.slice(position * MAX_INFLUENCES, position * MAX_INFLUENCES + MAX_INFLUENCES)).toEqual(
        straight.skinWeights.slice(original * MAX_INFLUENCES, original * MAX_INFLUENCES + MAX_INFLUENCES)
      );
    });
    expect(straight.skinIndices.slice(8 * MAX_INFLUENCES, 10 * MAX_INFLUENCES)).toEqual(
      source.skinIndices.slice(8 * MAX_INFLUENCES, 10 * MAX_INFLUENCES)
    );
    expect(straight.skinWeights.slice(8 * MAX_INFLUENCES, 10 * MAX_INFLUENCES)).toEqual(
      source.skinWeights.slice(8 * MAX_INFLUENCES, 10 * MAX_INFLUENCES)
    );
  });

  it("refuses invalid weights, out-of-range joints, wrong radius, and wrong cell coverage", () => {
    const broken = new SkinBinding({
      positions: [[0, 0, 0]],
      partIds: ["a"],
      skinIndices: [9, 0, 0, 0],
      skinWeights: [0.5, 0, 0, 0],
      jointCount: 2
    });
    expect(validateBinding(broken).some((message) => message.includes("sum(w)"))).toBe(true);
    expect(validateBinding(broken).some((message) => message.includes("outside"))).toBe(true);
    expect(() => blendWeights(broken, 0)).toThrow();
    expect(() => blendWeights(broken, 1, 0)).toThrow();
    const grid = new UniformGrid([[0, 0, 0]], BLEND_RADIUS);
    expect(() => grid.query([0, 0, 0], BLEND_RADIUS * 2)).toThrow();
    expect(CELL_OFFSETS).toHaveLength(27);
    expect(
      grid.query([0, 0, 0], BLEND_RADIUS)
    ).toEqual(bruteForceQuery([[0, 0, 0]], [0, 0, 0], BLEND_RADIUS));
    expect(WEIGHT_SUM_TOLERANCE).toBe(2e-7);
    const weld = weldCoincident(broken, 1);
    expect(weld.weldedGroups).toBe(0);
    expect(() => SkinBinding.fromJSON({ ...broken.toJSON(), unexpected: true })).toThrow(
      "unknown field 'unexpected'"
    );
  });
});
