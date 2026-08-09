import { describe, expect, it } from "vitest";
import { ciede2000, deltaERgb } from "../src/math/color-metrics.js";

const SHARMA = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644]
] as const;

describe("ported CIEDE2000", () => {
  it("matches Sharma/Wu/Dalal reference pairs", () => {
    for (const [first, second, expected] of SHARMA) {
      expect(ciede2000(first, second)).toBeCloseTo(expected, 3);
    }
  });

  it("is symmetric and zero for an identical RGB colour", () => {
    expect(deltaERgb([120, 40, 200], [120, 40, 200])).toBeCloseTo(0, 8);
    expect(ciede2000(SHARMA[0][0], SHARMA[0][1])).toBeCloseTo(
      ciede2000(SHARMA[0][1], SHARMA[0][0]),
      8
    );
  });
});

