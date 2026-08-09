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

  it("advances on strong semantic evidence despite low diagnostic scores", () => {
    const lowDiagnostic = evidence({
      overall: { score: 0.417777, confidence: 0.4 },
      regions: [
        {
          id: "full",
          pixels: 4096,
          score: 0.32,
          confidence: 0.35,
          signals: {
            structuralSimilarity: 0.3,
            perceptualHashSimilarity: 0.4,
            colorSimilarity: 0.35,
            deltaE00: 24
          },
          corrections: ["recheck material response"]
        }
      ],
      ambiguous: false
    });
    const result = gatePass({
      passId: "lighting-pass",
      compareResult: lowDiagnostic,
      semanticReview: {
        score: 0.82,
        confidence: 0.86,
        notes: "The corrected silhouette and critical features match the reference.",
        criticalFeatures: [
          { id: "silhouette", score: 0.84, threshold: 0.8, critical: true },
          { id: "identity-feature", score: 0.81, threshold: 0.78, critical: true }
        ]
      },
      threshold: 0.7,
      minimumConfidence: 0.65,
      attempt: 2,
      maxAttempts: 3
    });
    expect(result.decision).toBe("advance");
    expect(result.corrections).toEqual(
      expect.arrayContaining(["recheck material response"])
    );
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
