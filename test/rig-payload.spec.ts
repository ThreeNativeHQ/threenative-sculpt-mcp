import { describe, expect, it } from "vitest";
import { validateRigPayload } from "../src/rig-payload.js";

function payload() {
  return {
    schemaVersion: 1,
    coordinateSystem: { up: "Y", handedness: "right", unit: "normalized" },
    joints: [[0, 0, 0], [0, 1, 0], [0.5, 1.5, 0]],
    parents: [null, 0, 1],
    names: ["root", "spine", "arm_L"],
    matrix_local: [
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1],
      [1, 0, 0, 0.5, 0, 1, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 1]
    ],
    skinIndex: [[0, 1, 2, 0], [1, 2, 0, 0]],
    skinWeight: [[0.5, 0.3, 0.2, 0], [0.2, 0.8, 0, 0]]
  };
}

describe("rig payload structural gate", () => {
  it("accepts a valid four-slot rig payload", () => {
    const result = validateRigPayload(payload());
    expect(result.passed).toBe(true);
    expect(result.summary).toMatchObject({ jointCount: 3, vertexCount: 2, maxInfluences: 4 });
  });

  it("names parent, duplicate-name, matrix and weight failures", () => {
    const invalid = payload();
    invalid.parents[2] = 2;
    invalid.names[2] = "spine";
    invalid.matrix_local[1]![15] = 0;
    invalid.skinWeight[0] = [0.5, 0.5, 0.5, 0];
    const result = validateRigPayload(invalid);
    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/parent < child|duplicate joint name|affine last row|must sum to 1/);
  });

  it("fails closed on an unknown structural field and an out-of-range index", () => {
    const invalid = { ...payload(), extra: true };
    invalid.skinIndex[0]![0] = 9;
    const result = validateRigPayload(invalid);
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(["unknown field: extra"]));
    expect(result.errors.join(" ")).toContain("outside the joint array");
  });
});
