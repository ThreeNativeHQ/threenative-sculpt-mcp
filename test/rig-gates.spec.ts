import { describe, expect, it } from "vitest";
import { freeze } from "../src/mesh-parity.js";
import { runGates } from "../src/rig-gates.js";

function sampleClip() {
  const point = [0, 0, 0] as [number, number, number];
  return {
    sourceName: "walk",
    duration: 1,
    sampleTimes: [0, 0.25, 0.5, 0.75, 1],
    landmarkPositions: {
      hip: [point, point, point, point, point],
      head: [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]],
      "hand.l": [[0.3, 0.5, 0], [0.3, 0.5, 0], [0.3, 0.5, 0], [0.3, 0.5, 0], [0.3, 0.5, 0]],
      "hand.r": [[-0.3, 0.5, 0], [-0.3, 0.5, 0], [-0.3, 0.5, 0], [-0.3, 0.5, 0], [-0.3, 0.5, 0]],
      "foot.l": [[0.2, 0, 0], [0.2, 0, 0], [0.2, 0, 0], [0.2, 0, 0], [0.2, 0, 0]],
      "foot.r": [[-0.2, 0, 0], [-0.2, 0, 0], [-0.2, 0, 0], [-0.2, 0, 0], [-0.2, 0, 0]]
    },
    jointScaleDelta: [0, 0, 0, 0, 0],
    poseReturn: 0,
    stance: { "foot.l": [[0, 1]], "foot.r": [[0, 1]] }
  };
}

function skeleton() {
  return [
    { id: "root", parent: null, localPosition: [0, 0, 0] },
    { id: "hip", parent: "root", localPosition: [0, 0.5, 0] },
    { id: "leg.l", parent: "hip", localPosition: [0.4, -0.5, 0] },
    { id: "leg.r", parent: "hip", localPosition: [-0.4, -0.5, 0] },
    { id: "spine", parent: "hip", localPosition: [0, 0.4, 0] },
    { id: "shoulder", parent: "spine", localPosition: [0, 0.3, 0] },
    { id: "arm.l", parent: "shoulder", localPosition: [0.4, 0, 0] },
    { id: "arm.r", parent: "shoulder", localPosition: [-0.4, 0, 0] },
    { id: "head", parent: "shoulder", localPosition: [0, 0.3, 0] }
  ];
}

function basePayload() {
  const meshPayload = {
    meshes: [{ name: "body", attributes: { position: [0, 0, 0], normal: [0, 0, 1], uv: [0, 0] }, index: [0] }]
  };
  const manifest = freeze(meshPayload).toJSON();
  return {
    figureHeight: 1,
    clips: [sampleClip()],
    clipNames: ["walk"],
    bindingSamples: {
      source: "ThreeNative.clipTrackBindings",
      sampleTimes: [0, 0.25, 0.5, 0.75, 1],
      maxSampledBindingDelta: 0,
      clips: {
        walk: {
          sampleCount: 5,
          samples: [0, 0.25, 0.5, 0.75, 1].map((time) => ({
            time,
            mixerTime: time,
            tracks: 2,
            bound: 2,
            unbound: [],
            bindingDelta: 0
          }))
        }
      }
    },
    deformation: { nonFiniteCount: 0, allFinite: true, meshes: { body: { frames: 1, verticesPerFrame: 64 } } },
    bindRestore: { maxBindRestoreDelta: 0 },
    binding: { positions: [[0, 0, 0]], partIds: ["body"], skinIndices: [0, 0, 0, 0], skinWeights: [1, 0, 0, 0], jointCount: 1 },
    meshVisibility: { visibleMeshCount: 1, visibleSkinnedMeshCount: 1, unboundMeshes: [] },
    chainAnchors: {
      joints: skeleton(),
      sideLabels: { "leg.l": "left", "leg.r": "right", "arm.l": "left", "arm.r": "right" }
    },
    skinIntegritySweep: { clips: 1, times: 4, sides: 2, azimuths: 2, frames: 16, backgroundThroughSplitPx: 1, creasePx: 3, baseline: { backgroundThroughSplitPx: 2, creasePx: 1 } },
    meshParity: { manifest, after: meshPayload },
    rigReference: { source: "glb", glb: { ok: true, primarySkinIndex: 0, structuralFailure: null, unsupportedInterpolationClips: [], errors: [] } }
  };
}

describe("Stage R G1-G12", () => {
  it("returns all twelve passing gates for complete observations", () => {
    const report = runGates(basePayload());
    expect(report.ok).toBe(true);
    expect(report.results).toHaveLength(12);
    expect(report.results.map((result) => result.id)).toEqual(Array.from({ length: 12 }, (_, index) => `G${index + 1}`));
    expect(report.results.every((result) => result.status === "pass")).toBe(true);
  });

  it("fails closed for every missing evidence block", () => {
    const cases: Array<[string, string]> = [
      ["G1", "bindingSamples"], ["G2", "deformation"], ["G3", "bindRestore"], ["G4/G5", "binding"],
      ["G6", "meshVisibility"], ["G7", "chainAnchors"], ["G8/G9", "clips"], ["G10", "skinIntegritySweep"],
      ["G11", "meshParity"], ["G12", "rigReference"]
    ];
    for (const [name, key] of cases) {
      const payload = basePayload() as Record<string, unknown>;
      delete payload[key];
      const report = runGates(payload);
      const target = name.split("/").map((id) => report.byId(id));
      expect(target.every((gate) => gate.status === "unevaluated"), `${name} missing ${key}`).toBe(true);
      expect(report.ok, `${name} missing ${key} must block overall`).toBe(false);
    }
  });

  it("observes one red mutation per gate without short-circuiting the report", () => {
    const mutations: Record<string, (payload: Record<string, unknown>) => void> = {
      G1: (payload) => ((payload.bindingSamples as Record<string, unknown>).maxSampledBindingDelta = 1),
      G2: (payload) => ((payload.deformation as Record<string, unknown>).nonFiniteCount = 1),
      G3: (payload) => ((payload.bindRestore as Record<string, unknown>).maxBindRestoreDelta = 1),
      G4: (payload) => (((payload.binding as Record<string, unknown>).skinWeights as number[])[0] = 0.9),
      G5: (payload) => (((payload.binding as Record<string, unknown>).skinIndices as number[])[0] = 9),
      G6: (payload) => ((payload.meshVisibility as Record<string, unknown>).visibleSkinnedMeshCount = 0),
      G7: (payload) => delete (payload.chainAnchors as Record<string, unknown>).sideLabels,
      G8: (payload) => ((((payload.clips as Record<string, unknown>[])[0]!.landmarkPositions as Record<string, [number, number, number][]>)["foot.l"]![4]![0]) = 0.3),
      G9: (payload) => (((payload.clips as Record<string, unknown>[])[0]!.jointScaleDelta as number[])[2] = 0.1),
      G10: (payload) => ((payload.skinIntegritySweep as Record<string, unknown>).backgroundThroughSplitPx = 3),
      G11: (payload) => (((((payload.meshParity as Record<string, unknown>).after as Record<string, unknown>).meshes as Record<string, unknown>[])[0]!.attributes as Record<string, number[]>).position[1] = 0.01),
      G12: (payload) => { const reference = payload.rigReference as Record<string, unknown>; reference.source = "procedural"; }
    };
    for (const [id, mutate] of Object.entries(mutations)) {
      const payload = basePayload() as Record<string, unknown>;
      mutate(payload);
      const report = runGates(payload);
      expect(["fail", "unevaluated"], `${id} did not turn red`).toContain(report.byId(id).status);
      expect(report.ok, `${id} mutation incorrectly passed`).toBe(false);
      expect(report.results).toHaveLength(12);
      console.log(`negative-control ${id}: ${report.byId(id).status} — ${report.byId(id).reason}`);
    }
  });

  it("fails closed when a real track observation is absent or unbound", () => {
    const missingSample = structuredClone(basePayload()) as Record<string, unknown>;
    const missingBinding = missingSample.bindingSamples as Record<string, unknown>;
    delete (missingBinding.clips as Record<string, unknown>).walk;
    expect(runGates(missingSample).byId("G1").status).toBe("unevaluated");

    const unbound = structuredClone(basePayload()) as Record<string, unknown>;
    const entry = ((unbound.bindingSamples as Record<string, unknown>).clips as Record<string, unknown>).walk as Record<string, unknown>;
    const samples = entry.samples as Array<Record<string, unknown>>;
    samples[2]!.bound = 1;
    samples[2]!.unbound = [{ track: "Missing.quaternion", node: null, bound: false, reason: "missing node" }];
    samples[2]!.tracks = 2;
    samples[2]!.bindingDelta = 0.5;
    (unbound.bindingSamples as Record<string, unknown>).maxSampledBindingDelta = 0.5;
    const report = runGates(unbound);
    expect(report.byId("G1").status).toBe("fail");
    expect(report.byId("G1").reason).toContain("unbound");
  });

  it("fails closed when the binding delta is reconstructed instead of measured", () => {
    const payload = structuredClone(basePayload()) as Record<string, unknown>;
    const samples = (((payload.bindingSamples as Record<string, unknown>).clips as Record<string, unknown>).walk as Record<string, unknown>).samples as Array<Record<string, unknown>>;
    samples[0]!.bindingDelta = 0.25;
    expect(runGates(payload).byId("G1").status).toBe("unevaluated");
  });
});
