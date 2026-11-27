import { readFileSync } from "node:fs";

export const REQUIRED_LANDMARKS = [
  "hip",
  "head",
  "hand.l",
  "hand.r",
  "foot.l",
  "foot.r"
] as const;

export const IDLE_TRAVEL = 0.02;
export const IDLE_RISE = 0.02;
export const IN_PLACE_TRAVEL = 0.3;
export const WALK_SPEED = 0.3;
export const RUN_SPEED = 0.6;
export const DASH_SPEED = 1.5;
export const JUMP_RISE = 0.15;
export const LEAP_TRAVEL = 0.5;
export const PLANTED_FOOT_RANGE = 0.1;
export const GESTURE_HAND_RANGE = 0.4;
export const POSE_RETURN_DEGREES = 0.5;
export const LOOP_HIP_TOLERANCE = 0.01;
export const SCALE_DELTA_TRIPWIRE = 0;

export const MOTION_PRECEDENCE = [
  "leap",
  "jump",
  "dash",
  "run",
  "walk",
  "idle",
  "in-place"
] as const;

export const INTENT_WORDS = new Set([
  "attack",
  "cast",
  "celebrate",
  "climb",
  "dance",
  "defend",
  "dodge",
  "emote",
  "gesture",
  "hit",
  "idle",
  "jump",
  "kick",
  "leap",
  "react",
  "run",
  "shoot",
  "strike",
  "swim",
  "walk"
]);

export interface Thresholds {
  idleTravel: number;
  idleRise: number;
  inPlaceTravel: number;
  walkSpeed: number;
  runSpeed: number;
  dashSpeed: number;
  jumpRise: number;
  leapTravel: number;
  plantedFootRange: number;
  gestureHandRange: number;
  provenance: string;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  idleTravel: IDLE_TRAVEL,
  idleRise: IDLE_RISE,
  inPlaceTravel: IN_PLACE_TRAVEL,
  walkSpeed: WALK_SPEED,
  runSpeed: RUN_SPEED,
  dashSpeed: DASH_SPEED,
  jumpRise: JUMP_RISE,
  leapTravel: LEAP_TRAVEL,
  plantedFootRange: PLANTED_FOOT_RANGE,
  gestureHandRange: GESTURE_HAND_RANGE,
  provenance: "single-subject (11 clips, one rig, H = 1.0)"
};

export type Vec3 = [number, number, number];

export interface SampledClip {
  sourceName: string;
  duration: number;
  sampleTimes: number[];
  landmarkPositions: Record<string, Vec3[]>;
  jointScaleDelta: number[];
  poseReturn?: number | null;
  loop?: boolean | null;
  stance?: Record<string, number[][]>;
  [key: string]: unknown;
}

export interface SampledClipPayload {
  figureHeight: number;
  landmarks: string[];
  clips: SampledClip[];
  sourceScalesJoints?: boolean;
  sourceRanges?: Record<string, [number, number]>;
  authoredRanges?: Record<string, [number, number]>;
  [key: string]: unknown;
}

export interface ClipFeatures {
  sourceName: string;
  figureHeight: number;
  sampleCount: number;
  duration: number;
  travel: number;
  rise: number;
  speed: number;
  handRange: number;
  footRange: number;
  headRise: number;
  scaleDelta: number;
  scalesJoints: boolean;
  poseReturn: number | null;
  hipReturn: number;
  landmarkRanges: Record<string, Vec3>;
}

export interface Classification {
  labels: string[];
  primary: string | null;
  reasons: Record<string, string>;
  thresholds: Thresholds;
}

export interface LoopDecision {
  loop: boolean | null;
  reason: string;
  poseReturn: number | null;
  hipReturn: number;
  poseReturnLimit: number;
  hipTolerance: number;
}

export interface ClipName {
  sourceName: string;
  id: string;
  label: string;
  measured: string;
  inferred: boolean;
  loop: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function rangeMap(value: unknown, label: string): Record<string, [number, number]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be an object of [lo, hi] ranges`);
  const result: Record<string, [number, number]> = {};
  for (const [name, range] of Object.entries(value)) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(finite) || range[0]! > range[1]!) {
      throw new Error(`${label}.${JSON.stringify(name)} must be a finite ascending [lo, hi] range`);
    }
    result[name] = [range[0]!, range[1]!];
  }
  if (Object.keys(result).length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function vec3(value: unknown, label: string, clipName: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) {
    throw new Error(`clip ${JSON.stringify(clipName)}: ${label} must be a finite [x, y, z]`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function validateClip(value: unknown, figureHeight: number, landmarks: readonly string[]): SampledClip {
  if (!isRecord(value)) throw new Error("clip must be an object");
  const name = value.sourceName;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("clip.sourceName must be a non-empty string (it is never discarded)");
  }
  const duration = value.duration;
  if (!finite(duration) || duration <= 0) {
    throw new Error(`clip ${JSON.stringify(name)}: duration must be a finite positive number of seconds`);
  }
  const rawTimes = value.sampleTimes;
  if (!Array.isArray(rawTimes) || rawTimes.length < 2 || !rawTimes.every(finite)) {
    throw new Error(`clip ${JSON.stringify(name)}: sampleTimes must be a list of at least 2 finite times`);
  }
  const sampleTimes = rawTimes as number[];
  if (sampleTimes.some((time, index) => index > 0 && time < sampleTimes[index - 1]!)) {
    throw new Error(`clip ${JSON.stringify(name)}: sampleTimes must be non-decreasing`);
  }
  const positionsValue = value.landmarkPositions;
  if (!isRecord(positionsValue)) {
    throw new Error(`clip ${JSON.stringify(name)}: landmarkPositions must be an object`);
  }
  const landmarkPositions: Record<string, Vec3[]> = {};
  for (const landmark of landmarks) {
    const track = positionsValue[landmark];
    if (!Array.isArray(track)) {
      throw new Error(
        `clip ${JSON.stringify(name)}: landmarkPositions is missing required landmark ${JSON.stringify(landmark)}`
      );
    }
    if (track.length !== sampleTimes.length) {
      throw new Error(
        `clip ${JSON.stringify(name)}: sampleTimes has ${sampleTimes.length} entries but landmarkPositions[${JSON.stringify(landmark)}] has ${track.length}`
      );
    }
    landmarkPositions[landmark] = track.map((point, index) =>
      vec3(point, `landmarkPositions[${JSON.stringify(landmark)}][${index}]`, name)
    );
  }
  const scaleValue = value.jointScaleDelta;
  if (!Array.isArray(scaleValue) || scaleValue.length !== sampleTimes.length || !scaleValue.every(finite)) {
    throw new Error(
      `clip ${JSON.stringify(name)}: jointScaleDelta must contain one finite number per sample`
    );
  }
  const stanceValue = value.stance;
  let stance: Record<string, number[][]> | undefined;
  if (stanceValue !== undefined) {
    if (!isRecord(stanceValue)) {
      throw new Error(`clip ${JSON.stringify(name)}: stance must be an object keyed by foot landmark`);
    }
    stance = {};
    for (const [foot, intervals] of Object.entries(stanceValue)) {
      if (!Array.isArray(intervals)) {
        throw new Error(`clip ${JSON.stringify(name)}: stance[${JSON.stringify(foot)}] must be a list`);
      }
      stance[foot] = intervals.map((interval, index) => {
        if (
          !Array.isArray(interval) ||
          interval.length !== 2 ||
          !interval.every(finite) ||
          (interval[0] as number) > (interval[1] as number)
        ) {
          throw new Error(
            `clip ${JSON.stringify(name)}: stance[${JSON.stringify(foot)}][${index}] must be [t0, t1]`
          );
        }
        return [interval[0] as number, interval[1] as number];
      });
    }
  }
  const poseReturn = value.poseReturn;
  if (poseReturn !== undefined && poseReturn !== null && !finite(poseReturn)) {
    throw new Error(`clip ${JSON.stringify(name)}: poseReturn must be a finite number or omitted`);
  }
  const loop = value.loop;
  if (loop !== undefined && loop !== null && typeof loop !== "boolean") {
    throw new Error(`clip ${JSON.stringify(name)}: loop must be boolean, null, or omitted`);
  }
  const result: SampledClip = {
    sourceName: name,
    duration,
    sampleTimes: [...sampleTimes],
    landmarkPositions,
    jointScaleDelta: [...(scaleValue as number[])]
  };
  if (poseReturn !== undefined) result.poseReturn = poseReturn as number | null;
  if (loop !== undefined) result.loop = loop as boolean | null;
  if (stance !== undefined) result.stance = stance;
  return result;
}

export function loadClipPayload(value: unknown): SampledClipPayload {
  if (!isRecord(value)) throw new Error("sampled-clip payload root must be an object");
  const figureHeight = value.figureHeight;
  if (!finite(figureHeight) || figureHeight <= 0) {
    throw new Error("figureHeight must be a finite positive number");
  }
  const rawLandmarks = value.landmarks ?? [...REQUIRED_LANDMARKS];
  if (!Array.isArray(rawLandmarks) || !rawLandmarks.every((item) => typeof item === "string")) {
    throw new Error("landmarks must be a list of strings");
  }
  const landmarks = rawLandmarks as string[];
  const missing = REQUIRED_LANDMARKS.filter((landmark) => !landmarks.includes(landmark));
  if (missing.length > 0) {
    throw new Error(`landmarks is missing ${missing.join(", ")}; §1 requires all six landmarks`);
  }
  const clipsValue = value.clips;
  if (!Array.isArray(clipsValue) || clipsValue.length === 0) {
    throw new Error("clips must be a non-empty list");
  }
  if (value.sourceScalesJoints !== undefined && typeof value.sourceScalesJoints !== "boolean") {
    throw new Error("sourceScalesJoints must be boolean when supplied");
  }
  const sourceRanges = rangeMap(value.sourceRanges, "sourceRanges");
  const authoredRanges = rangeMap(value.authoredRanges, "authoredRanges");
  return {
    figureHeight,
    landmarks: [...landmarks],
    clips: clipsValue.map((clip) => validateClip(clip, figureHeight, REQUIRED_LANDMARKS)),
    ...(value.sourceScalesJoints === undefined ? {} : { sourceScalesJoints: value.sourceScalesJoints }),
    ...(sourceRanges === undefined ? {} : { sourceRanges }),
    ...(authoredRanges === undefined ? {} : { authoredRanges })
  };
}

export function loadClipPayloadFile(filePath: string): SampledClipPayload {
  return loadClipPayload(JSON.parse(readFileSync(filePath, "utf8")));
}

function axisRange(tracks: Vec3[][]): Vec3 {
  return [0, 1, 2].map((axis) => {
    const values = tracks.flatMap((track) => track.map((point) => point[axis]!));
    return Math.max(...values) - Math.min(...values);
  }) as Vec3;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function measureClip(clip: Record<string, unknown>, figureHeight: number): ClipFeatures {
  const validated = validateClip(clip, figureHeight, REQUIRED_LANDMARKS);
  const positions = validated.landmarkPositions;
  const hip = positions.hip!;
  const firstHip = hip[0]!;
  const travel =
    Math.max(...hip.map((point) => Math.hypot(point[0] - firstHip[0], point[2] - firstHip[2]))) /
    figureHeight;
  const rise =
    (Math.max(...hip.map((point) => point[1])) - Math.min(...hip.map((point) => point[1]))) /
    figureHeight;
  const speed = travel / validated.duration;
  const landmarkRanges = Object.fromEntries(
    Object.entries(positions).map(([name, track]) => [
      name,
      axisRange([track]).map((value) => value / figureHeight) as Vec3
    ])
  );
  const handRange = Math.max(...axisRange([positions["hand.l"]!, positions["hand.r"]!])) / figureHeight;
  const footRange = Math.max(...axisRange([positions["foot.l"]!, positions["foot.r"]!])) / figureHeight;
  const scaleDelta = Math.max(...validated.jointScaleDelta, 0);
  const lastHip = hip[hip.length - 1]!;
  return {
    sourceName: validated.sourceName,
    figureHeight,
    sampleCount: validated.sampleTimes.length,
    duration: validated.duration,
    travel,
    rise,
    speed,
    handRange,
    footRange,
    headRise: landmarkRanges.head![1],
    scaleDelta,
    scalesJoints: scaleDelta > SCALE_DELTA_TRIPWIRE,
    poseReturn: validated.poseReturn ?? null,
    hipReturn: distance(lastHip, firstHip) / figureHeight,
    landmarkRanges
  };
}

export function classify(features: ClipFeatures, thresholds: Thresholds = DEFAULT_THRESHOLDS): Classification {
  const labels: string[] = [];
  const reasons: Record<string, string> = {};
  const hit = (label: string, reason: string) => {
    labels.push(label);
    reasons[label] = reason;
  };
  if (features.travel < thresholds.idleTravel && features.rise < thresholds.idleRise) {
    hit("idle", `travel ${features.travel.toFixed(4)} < ${thresholds.idleTravel} and rise ${features.rise.toFixed(4)} < ${thresholds.idleRise}`);
  }
  const inPlace = features.travel < thresholds.inPlaceTravel;
  if (inPlace) hit("in-place", `travel ${features.travel.toFixed(4)} < ${thresholds.inPlaceTravel}`);
  if (thresholds.walkSpeed <= features.speed && features.speed < thresholds.runSpeed) {
    hit("walk", `${thresholds.walkSpeed} <= speed ${features.speed.toFixed(4)} < ${thresholds.runSpeed}`);
  }
  if (thresholds.runSpeed <= features.speed && features.speed < thresholds.dashSpeed) {
    hit("run", `${thresholds.runSpeed} <= speed ${features.speed.toFixed(4)} < ${thresholds.dashSpeed}`);
  }
  if (features.speed >= thresholds.dashSpeed) {
    hit("dash", `speed ${features.speed.toFixed(4)} >= ${thresholds.dashSpeed}`);
  }
  if (features.rise >= thresholds.jumpRise && features.travel < thresholds.leapTravel) {
    hit("jump", `rise ${features.rise.toFixed(4)} >= ${thresholds.jumpRise} and travel ${features.travel.toFixed(4)} < ${thresholds.leapTravel}`);
  }
  if (features.rise >= thresholds.jumpRise && features.travel >= thresholds.leapTravel) {
    hit("leap", `rise ${features.rise.toFixed(4)} >= ${thresholds.jumpRise} and travel ${features.travel.toFixed(4)} >= ${thresholds.leapTravel}`);
  }
  if (features.footRange < thresholds.plantedFootRange) {
    hit("planted", `footRange ${features.footRange.toFixed(4)} < ${thresholds.plantedFootRange}`);
  }
  if (inPlace && features.handRange >= thresholds.gestureHandRange) {
    hit("gesture", `handRange ${features.handRange.toFixed(4)} >= ${thresholds.gestureHandRange} while in-place`);
  }
  return {
    labels,
    primary: MOTION_PRECEDENCE.find((label) => labels.includes(label)) ?? null,
    reasons,
    thresholds: { ...thresholds }
  };
}

export function decideLoop(
  features: ClipFeatures,
  poseReturnLimit = POSE_RETURN_DEGREES,
  hipTolerance = LOOP_HIP_TOLERANCE
): LoopDecision {
  if (features.poseReturn === null) {
    return {
      loop: null,
      reason: "poseReturn not measured",
      poseReturn: null,
      hipReturn: features.hipReturn,
      poseReturnLimit,
      hipTolerance
    };
  }
  const poseOk = features.poseReturn <= poseReturnLimit;
  const hipOk = features.hipReturn <= hipTolerance;
  if (poseOk && hipOk) {
    return {
      loop: true,
      reason: `poseReturn ${features.poseReturn.toFixed(3)} deg <= ${poseReturnLimit} and ||hip(T) - hip(0)|| ${features.hipReturn.toFixed(4)}H <= ${hipTolerance}H`,
      poseReturn: features.poseReturn,
      hipReturn: features.hipReturn,
      poseReturnLimit,
      hipTolerance
    };
  }
  const failures = [
    ...(poseOk ? [] : [`poseReturn ${features.poseReturn.toFixed(3)} deg > ${poseReturnLimit}`]),
    ...(hipOk ? [] : [`||hip(T) - hip(0)|| ${features.hipReturn.toFixed(4)}H > ${hipTolerance}H`])
  ];
  return {
    loop: false,
    reason: failures.join("; "),
    poseReturn: features.poseReturn,
    hipReturn: features.hipReturn,
    poseReturnLimit,
    hipTolerance
  };
}

export function legacyLoopRule(features: ClipFeatures, thresholds: Thresholds = DEFAULT_THRESHOLDS): boolean {
  return features.travel < thresholds.idleTravel && features.rise < thresholds.idleRise;
}

function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "clip";
}

export function labelImpliesIntent(label: string, intentWords: Set<string> = INTENT_WORDS): boolean {
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((word) => intentWords.has(word));
}

function measuredSummary(features: ClipFeatures, classification: Classification): string {
  const keys = [...({
    walk: ["speed", "rise"],
    run: ["speed", "rise"],
    dash: ["speed", "travel"],
    jump: ["rise", "travel"],
    leap: ["rise", "travel"],
    idle: ["travel", "rise"],
    "in-place": ["travel", "rise"]
  } as Record<string, string[]>)[classification.primary ?? ""] ?? ["travel", "rise", "speed"]];
  if (classification.labels.includes("planted") && !keys.includes("footRange")) keys.push("footRange");
  if (classification.labels.includes("gesture") && !keys.includes("handRange")) keys.push("handRange");
  const values: Record<string, string> = {
    speed: `speed ${features.speed.toFixed(3)} H/s`,
    travel: `travel ${features.travel.toFixed(3)}H`,
    rise: `rise ${features.rise.toFixed(3)}H`,
    handRange: `handRange ${features.handRange.toFixed(3)}H`,
    footRange: `footRange ${features.footRange.toFixed(3)}H`
  };
  return keys.map((key) => values[key]!).join(", ");
}

export function nameClip(
  features: ClipFeatures,
  label: string,
  options: {
    clipId?: string;
    inferred?: boolean;
    loop?: boolean | null;
    sourceName?: string;
    classification?: Classification;
  } = {}
): ClipName {
  const classification = options.classification ?? classify(features);
  return {
    sourceName: options.sourceName ?? features.sourceName,
    id: options.clipId ?? slug(label),
    label,
    measured: measuredSummary(features, classification),
    inferred: options.inferred ?? labelImpliesIntent(label),
    loop: options.loop === undefined ? decideLoop(features).loop : options.loop
  };
}

export function report(payloadValue: unknown): Record<string, unknown> {
  const payload = loadClipPayload(payloadValue);
  const clips = payload.clips.map((clip) => {
    const features = measureClip(clip, payload.figureHeight);
    const classification = classify(features);
    const loop = decideLoop(features);
    const label = classification.primary ?? features.sourceName;
    return {
      sourceName: features.sourceName,
      features,
      classification,
      loop,
      name: nameClip(features, label, { classification, loop: loop.loop })
    };
  });
  const tripped = clips
    .filter((entry) => (entry.features as ClipFeatures).scalesJoints)
    .map((entry) => entry.sourceName as string);
  return {
    schemaVersion: 1,
    kind: "clip-features",
    figureHeight: payload.figureHeight,
    clipCount: clips.length,
    scaleTripwire: {
      limit: SCALE_DELTA_TRIPWIRE,
      tripped: tripped.length > 0,
      clips: tripped,
      sourceScalesJointsDeclared: payload.sourceScalesJoints === true,
      note: "A non-zero scaleDelta means the source rig scales joints, which changes what Stage R2 may legally do to skin weights."
    },
    clips
  };
}

export const measure_clip = measureClip;
export const decide_loop = decideLoop;
export const name_clip = nameClip;
export const load_payload = loadClipPayload;
