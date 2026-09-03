import { describe, expect, it } from "vitest";
import {
  checkMedialLateral,
  footSlide,
  gaitParameters,
  resolveChains,
  runTargets,
  synthesiseGaitTracks,
  walkTargets
} from "../src/action-design.js";
import { classify, measureClip } from "../src/clip-features.js";

function humanoid() {
  return [
    { id: "root", parent: null, localPosition: [0, 0, 0] },
    { id: "hip", parent: "root", localPosition: [0, 0.5, 0] },
    { id: "leg-left", parent: "hip", localPosition: [0.1, -0.1, 0] },
    { id: "foot-left", parent: "leg-left", localPosition: [0, -0.4, 0] },
    { id: "leg-right", parent: "hip", localPosition: [-0.1, -0.1, 0] },
    { id: "foot-right", parent: "leg-right", localPosition: [0, -0.4, 0] },
    { id: "spine", parent: "hip", localPosition: [0, 0.5, 0] },
    { id: "shoulders", parent: "spine", localPosition: [0, 0.3, 0] },
    { id: "arm-left", parent: "shoulders", localPosition: [0.3, 0, 0] },
    { id: "hand-left", parent: "arm-left", localPosition: [0.3, 0, 0] },
    { id: "arm-right", parent: "shoulders", localPosition: [-0.3, 0, 0] },
    { id: "hand-right", parent: "arm-right", localPosition: [-0.3, 0, 0] },
    { id: "head", parent: "shoulders", localPosition: [0, 0.3, 0] }
  ];
}

describe("Stage R action design", () => {
  it("keeps classifier boundaries and derives a phase-machine walk", () => {
    const band = walkTargets(1);
    expect(band.ranges.speed.contains(0.599)).toBe(true);
    expect(band.ranges.speed.contains(0.6)).toBe(false);
    const params = gaitParameters(band, 1);
    const authored = synthesiseGaitTracks(params);
    const measured = measureClip(authored, 1);
    expect(classify(measured).primary).toBe("walk");
    expect(footSlide(authored.landmarkPositions, authored.sampleTimes, authored.stance!, 1).status).toBe("pass");
  });

  it("reports the run flight phase and missing stance as unevaluated", () => {
    const params = gaitParameters(runTargets(2), 2);
    expect(params.flightFraction).toBeCloseTo(0.2);
    const authored = synthesiseGaitTracks(params);
    const missing = { ...authored };
    delete missing.stance;
    expect(footSlide(missing.landmarkPositions, missing.sampleTimes, {}, 2).status).toBe("unevaluated");
  });

  it("resolves chains from topology and gives the medial gate an independent side claim", () => {
    const nodes = humanoid();
    const chains = resolveChains(nodes, {
      "leg-left": "l", "foot-left": "l", "leg-right": "r", "foot-right": "r",
      "arm-left": "l", "hand-left": "l", "arm-right": "r", "hand-right": "r"
    });
    expect(chains.leg.l.jointIds).toEqual(["leg-left", "foot-left"]);
    expect(chains.arm.r.jointIds).toEqual(["arm-right", "hand-right"]);
    expect(chains.gateIsIndependent).toBe(true);
    expect(checkMedialLateral(chains)).toHaveLength(0);
    const swapped = resolveChains(nodes, {
      "leg-left": "r", "foot-left": "r", "leg-right": "l", "foot-right": "l",
      "arm-left": "r", "hand-left": "r", "arm-right": "l", "hand-right": "l"
    });
    expect(checkMedialLateral(swapped).join(" ")).toContain("expected x");
  });

  it("rejects a sliding contact frame instead of smoothing it away", () => {
    const params = gaitParameters(walkTargets(1), 1);
    const authored = synthesiseGaitTracks(params);
    const positions = { ...authored.landmarkPositions, "foot.l": authored.landmarkPositions["foot.l"]!.map((point, index) => [point[0] + index * 0.02, point[1], point[2]] as [number, number, number]) };
    expect(footSlide(positions, authored.sampleTimes, authored.stance!, 1).status).toBe("fail");
  });
});
