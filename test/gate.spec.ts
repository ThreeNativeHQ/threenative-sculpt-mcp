import { describe, expect, it } from "vitest";
import type { SculptCompareResult } from "../src/image.js";
import { gatePass } from "../src/gate.js";

function evidence(overrides: Partial<SculptCompareResult> = {}): SculptCompareResult {
  return {
    status: "evidence",
    authority: "diagnostic-only",
    referencePath: "reference.png",
    capturePath: "capture.png",
    dimensions: {
      reference: { width: 64, height: 64 },
      capture: { width: 64, height: 64 },
      normalizedForComparison: { width: 64, height: 64 }
    },
    overall: { score: 0.9, confidence: 0.9 },
    regions: [
      {
        id: "full",
        pixels: 4096,
        score: 0.9,
        confidence: 0.9,
        signals: {
          structuralSimilarity: 0.9,
          perceptualHashSimilarity: 0.9,
          colorSimilarity: 0.9,
          deltaE00: 1
        },
        corrections: []
      }
    ],
    ambiguous: false,
    notes: [],
    ...overrides
  };
}

const semanticReview = {
  score: 0.9,
  confidence: 0.9,
  notes: "Silhouette and structure reviewed against the same pair.",
  criticalFeatures: [{ id: "silhouette", score: 0.9, threshold: 0.8, critical: true }]
};

describe("pass gate", () => {
  it("retries when semantic evidence is missing", () => {
    const result = gatePass({
      passId: "blockout",
      compareResult: evidence(),
      threshold: 0.7,
      minimumConfidence: 0.65,
      attempt: 1,
      maxAttempts: 3
    });
    expect(result.decision).toBe("retry");
    expect(result.reasons.join(" ")).toContain("deterministic pixels cannot advance");
  });

  it("retries ambiguous evidence and never advances it", () => {
    const result = gatePass({
      passId: "structural-pass",
      compareResult: evidence({ ambiguous: true }),
      semanticReview,
      threshold: 0.7,
      minimumConfidence: 0.65,
      attempt: 1,
      maxAttempts: 3
    });
    expect(result.decision).toBe("retry");
  });

  it("advances only when diagnostics and semantic critical features pass", () => {
    expect(
      gatePass({
        passId: "form-refinement",
        compareResult: evidence(),
        semanticReview,
        threshold: 0.7,
        minimumConfidence: 0.65,
        attempt: 1,
        maxAttempts: 3
      }).decision
    ).toBe("advance");
  });

  it("stops after the bounded final failed attempt", () => {
    expect(
      gatePass({
        passId: "material-pass",
        compareResult: evidence({ ambiguous: true }),
        semanticReview,
        threshold: 0.7,
        minimumConfidence: 0.65,
        attempt: 3,
        maxAttempts: 3
      }).decision
    ).toBe("stop");
  });
});

