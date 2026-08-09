import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { gateObjectSculptSpec } from "../src/spec.js";

function json(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function simpleSpec() {
  return json("examples/simple-object-sculpt-spec.json");
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

  it("accepts the packaged example through JSON Schema and the semantic gate", () => {
    const schema = json("schema/object-sculpt-spec.runtime.schema.json");
    const spec = simpleSpec();
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(spec), ajv.errorsText(validate.errors)).toBe(true);
    expect(gateObjectSculptSpec(spec)).toMatchObject({
      valid: true,
      tier: "simple",
      requiredDepth: { reviewViewpoints: 2, detailInventory: 3 }
    });
  });

  it("rejects the formerly schema-valid mismatched nested shape", () => {
    const schema = json("schema/object-sculpt-spec.runtime.schema.json");
    const spec = simpleSpec();
    spec.preSpecAssessment = { complexity: "simple", detailInventory: [] };
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    expect(validate(spec)).toBe(false);
    expect(validate.errors?.map((error) => error.instancePath)).toEqual(
      expect.arrayContaining([
        "/preSpecAssessment/complexity",
        "/preSpecAssessment/detailInventory"
      ])
    );
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
