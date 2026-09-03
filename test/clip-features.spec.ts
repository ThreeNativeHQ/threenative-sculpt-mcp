import { describe, expect, it } from "vitest";
import {
  classify,
  decideLoop,
  DEFAULT_THRESHOLDS,
  legacyLoopRule,
  loadClipPayload,
  measureClip,
  nameClip,
  report,
  type SampledClip
} from "../src/clip-features.js";

function clip(options: {
  name?: string;
  travel?: number;
  rise?: number;
  duration?: number;
  returns?: boolean;
  poseReturn?: number | null;
  scaleDelta?: number;
} = {}): SampledClip {
  const samples = 5;
  const travel = options.travel ?? 0.4;
  const rise = options.rise ?? 0.02;
  const positions = Object.fromEntries(
    ["hip", "head", "hand.l", "hand.r", "foot.l", "foot.r"].map((name) => [name, []])
  ) as SampledClip["landmarkPositions"];
  for (let index = 0; index < samples; index += 1) {
    const unit = index / (samples - 1);
    const root = options.returns ? travel * Math.sin(Math.PI * unit) : travel * unit;
    const hipY = 0.5 + rise * 0.5 * Math.sin(2 * Math.PI * unit);
    positions.hip!.push([root, hipY, 0]);
    positions.head!.push([root, hipY + 0.4, 0]);
    positions["hand.l"]!.push([root + 0.1 * Math.sin(2 * Math.PI * unit), hipY + 0.05, 0.25]);
    positions["hand.r"]!.push([root - 0.1 * Math.sin(2 * Math.PI * unit), hipY + 0.05, -0.25]);
    positions["foot.l"]!.push([root + 0.02, 0, 0]);
    positions["foot.r"]!.push([root - 0.02, 0, 0]);
  }
  const result: SampledClip = {
    sourceName: options.name ?? "NlaTrack",
    duration: options.duration ?? 1,
    sampleTimes: Array.from({ length: samples }, (_, index) => index / (samples - 1)),
    landmarkPositions: positions,
    jointScaleDelta: Array.from({ length: samples }, (_, index) => index === 2 ? options.scaleDelta ?? 0 : 0)
  };
  if (options.poseReturn !== null) result.poseReturn = options.poseReturn ?? 0;
  return result;
}

describe("Stage R clip vocabulary", () => {
  it("measures normalized world-space features and all matching labels", () => {
    const features = measureClip(clip({ travel: 0.05, rise: 0.008 }), 1);
    const classification = classify(features);
    expect(features.travel).toBeCloseTo(0.05);
    expect(features.rise).toBeCloseTo(0.008);
    expect(classification.primary).toBe("in-place");
    expect(classification.labels).toEqual(["in-place", "planted", "gesture"]);
  });

  it("keeps the same classification at a different figure height", () => {
    const one = measureClip(clip({ travel: 0.4, rise: 0.02 }), 1);
    const two = measureClip({ ...clip({ travel: 0.4, rise: 0.02 }), landmarkPositions: Object.fromEntries(Object.entries(clip({ travel: 0.4, rise: 0.02 }).landmarkPositions).map(([name, track]) => [name, track.map((point) => point.map((value) => value * 2) as [number, number, number])])) }, 2);
    expect(two.travel).toBeCloseTo(one.travel);
    expect(two.rise).toBeCloseTo(one.rise);
    expect(classify(two).labels).toEqual(classify(one).labels);
  });

  it("uses pose return and hip return for looping, not the old idle rule", () => {
    const features = measureClip(clip({ travel: 0.121, rise: 0.01, returns: true, poseReturn: 0.2 }), 1);
    expect(legacyLoopRule(features)).toBe(false);
    expect(decideLoop(features).loop).toBe(true);
    expect(decideLoop(measureClip(clip({ poseReturn: null }), 1)).loop).toBeNull();
    expect(DEFAULT_THRESHOLDS.idleTravel).toBe(0.02);
  });

  it("surfaces scale as a tripwire and preserves the source name in an inferred label", () => {
    const features = measureClip(clip({ scaleDelta: 0.004 }), 1);
    expect(features.scalesJoints).toBe(true);
    const name = nameClip(features, "strike");
    expect(name).toMatchObject({ sourceName: "NlaTrack", inferred: true, id: "strike" });
  });

  it("fails closed for missing landmarks and empty clip lists", () => {
    expect(() => loadClipPayload({ figureHeight: 1, clips: [] })).toThrow("clips must be a non-empty list");
    const malformed = clip();
    delete malformed.landmarkPositions["foot.r"];
    expect(() => loadClipPayload({ figureHeight: 1, clips: [malformed] })).toThrow("foot.r");
  });

  it("reports every clip and its scale tripwire", () => {
    const result = report({ figureHeight: 1, clips: [clip({ name: "clean" }), clip({ name: "scaled", scaleDelta: 0.1 })] });
    expect(result).toMatchObject({ clipCount: 2, scaleTripwire: { tripped: true, clips: ["scaled"] } });
  });
});
