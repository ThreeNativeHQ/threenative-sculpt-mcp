import { describe, expect, it } from "vitest";
import { gateObjectSculptSpec } from "../src/spec.js";

function simpleSpec() {
  return {
    schemaVersion: "2.1",
    targetName: "Reference object",
    suitability: "pass",
    coordinateFrame: {},
    silhouette: {},
    componentTree: [{ id: "root", level: "macro", localFeatures: [] }],
    materials: [{ id: "base" }],
    repetitionSystems: [],
    proceduralStrategy: ["Build the observed silhouette"],
    preSpecAssessment: {
      complexity: { tier: "simple" },
      detailInventory: { details: [{}, {}, {}] }
    },
    qualityContract: {
      minimumSpecDepth: {
        macroComponents: 1,
        mesoComponents: 0,
        microFeatureGroups: 0,
        materialLayers: 1,
        repetitionSystems: 0,
        reviewViewpoints: 2
      }
    },
    qualityTargets: { reviewViewpoints: ["front", "three-quarter"] }
  };
}

describe("ObjectSculptSpec runtime gate", () => {
  it("fails {} and names every missing required region", () => {
    const result = gateObjectSculptSpec({});
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      region: "silhouette",
      message: 'missing required ObjectSculptSpec region "silhouette"'
    });
    expect(result.issues.map((issue) => issue.region)).toContain("componentTree");
  });

  it("accepts a simple spec at every canonical depth threshold", () => {
    expect(gateObjectSculptSpec(simpleSpec())).toMatchObject({
      valid: true,
      tier: "simple",
      requiredDepth: { reviewViewpoints: 2, detailInventory: 3 }
    });
  });

  it("fails a shallow moderate spec with named count gaps", () => {
    const spec = simpleSpec();
    spec.preSpecAssessment.complexity.tier = "moderate";
    const result = gateObjectSculptSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.region)).toEqual(
      expect.arrayContaining(["macroComponents", "mesoComponents", "microFeatureGroups", "detailInventory"])
    );
  });
});

