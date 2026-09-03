import { describe, expect, it } from "vitest";
import {
  KIND_ATTRIBUTE_ADDED,
  KIND_ATTRIBUTE_MISSING,
  KIND_HASH,
  KIND_MESH_ADDED,
  KIND_MESH_MISSING,
  Manifest,
  STATUS_FAIL,
  STATUS_PASS,
  freeze,
  verify
} from "../src/mesh-parity.js";

function meshPayload() {
  return {
    meshes: [
      {
        name: "Raz",
        attributes: {
          position: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          normal: [0, 0, 1, 0, 0, 1, 0, 0, 1],
          uv: [0, 0, 1, 0, 0, 1]
        },
        index: [0, 1, 2]
      }
    ]
  };
}

describe("mesh parity", () => {
  it("freezes packed geometry, survives JSON reformatting, and reports legal skin additions", () => {
    const source = meshPayload();
    const manifest = freeze(source);
    const roundTrip = Manifest.fromJSON(JSON.parse(JSON.stringify(manifest.toJSON(), null, 2)));
    const after = {
      meshes: [
        {
          ...source.meshes[0],
          attributes: {
            ...source.meshes[0]!.attributes,
            skinIndex: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
            skinWeight: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
          }
        }
      ]
    };
    const result = verify(roundTrip, after);
    expect(result.status).toBe(STATUS_PASS);
    expect(result.ok).toBe(true);
    expect(result.additions).toEqual(["Raz.skinIndex", "Raz.skinWeight"]);
    expect(result.failureCount).toBe(0);
  });

  it("locates a nudged float and rejects missing, added, and changed mesh data", () => {
    const manifest = freeze(meshPayload());
    const nudged = meshPayload();
    nudged.meshes[0]!.attributes.position[1] = 0.001;
    const nudgeReport = verify(manifest, nudged);
    expect(nudgeReport.status).toBe(STATUS_FAIL);
    expect(nudgeReport.failures[0]!.kind).toBe(KIND_HASH);
    expect(nudgeReport.failures[0]!.differences[0]).toMatchObject({ index: 1, frozen: 0, current: 0.001 });

    const removed = verify(manifest, { meshes: [] });
    expect(removed.failures[0]!.kind).toBe(KIND_MESH_MISSING);
    const added = verify(manifest, { meshes: [...meshPayload().meshes, { name: "new", attributes: { position: [0, 0, 0] } }] });
    expect(added.failures[0]!.kind).toBe(KIND_MESH_ADDED);

    const changedIndex = meshPayload();
    changedIndex.meshes[0]!.index = [0, 2, 1];
    expect(verify(manifest, changedIndex).failures.some((failure) => failure.attribute === "index")).toBe(true);
  });

  it("distinguishes missing frozen attributes from newly added frozen attributes", () => {
    const positionOnly = { meshes: [{ name: "part", attributes: { position: [0, 0, 0] } }] };
    const manifest = freeze(positionOnly);
    const missing = verify(manifest, { meshes: [{ name: "part", attributes: {} }] });
    expect(missing.failures[0]!.kind).toBe(KIND_ATTRIBUTE_MISSING);
    const added = verify(manifest, { meshes: [{ name: "part", attributes: { position: [0, 0, 0], uv: [0, 0] } }] });
    expect(added.failures[0]!.kind).toBe(KIND_ATTRIBUTE_ADDED);
  });

  it("fails closed when there is no manifest or no frozen mesh", () => {
    expect(verify(undefined, meshPayload()).status).toBe("unevaluated");
    expect(freeze({ meshes: [] }).meshes).toHaveLength(0);
    expect(verify(freeze({ meshes: [] }), meshPayload()).status).toBe("unevaluated");
    expect(() => freeze({ meshes: [{ name: "part", attributes: { position: [0, 0] } }] })).toThrow();
  });
});
