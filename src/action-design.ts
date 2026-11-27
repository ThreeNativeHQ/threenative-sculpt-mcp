import {
  classify,
  DEFAULT_THRESHOLDS,
  measureClip,
  type ClipFeatures,
  type SampledClip
} from "./clip-features.js";

export const FOOT_SLIDE_LIMIT = 0.01;
export const POSE_RETURN_DEGREES = 0.5;
export const SYMMETRY_TOLERANCE = 1e-4;
export const FOOT_RANGE_TOLERANCE = 0.3;
export const MEDIAL_AXIS_TOLERANCE: number | undefined = undefined;
export const LIMB_FEATURE_FRAME = "hip-relative";
export const MOTION_CLASSES = ["idle", "walk", "run", "dash", "jump", "leap"] as const;
export const SAMPLE_COUNT = 25;
export const FOOT_LIFT_FRACTION_OF_STRIDE = 0.12;
export const HIP_HEIGHT_FRACTION = 0.55;
export const ARM_LATERAL_FRACTION = 0.18;
export const FOOT_LATERAL_FRACTION = 0.09;
export const HAND_HEIGHT_FRACTION = 0.55;
export const HEAD_HEIGHT_FRACTION = 0.94;

export type Status = "pass" | "fail" | "unevaluated";
export type Vec3 = [number, number, number];

export interface JointNode {
  id: string;
  parent: string | null;
  localPosition: Vec3;
}

export interface Chain {
  name: string;
  jointIds: string[];
  anchorPosition: Vec3;
  anchor: string;
  leaf: string;
}

export interface Chains {
  spine: Chain;
  arm: { l: Chain; r: Chain };
  leg: { l: Chain; r: Chain };
  worldPositions: Record<string, Vec3>;
  sideSource: "labels" | "model-x";
  symmetryTolerance: number;
  notes: string[];
  gateIsIndependent: boolean;
}

export class ChainResolutionError extends Error {
  override name = "ChainResolutionError";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new ChainResolutionError(`${label} must be a finite length-3 vector`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function coerceNodes(values: Iterable<unknown>): JointNode[] {
  return [...values].map((value, index) => {
    if (record(value)) {
      const id = value.id ?? value.name;
      if (!id) throw new ChainResolutionError(`node ${index} has no id`);
      return {
        id: String(id),
        parent: value.parent === undefined || value.parent === null || value.parent === "" ? null : String(value.parent),
        localPosition: vec3(value.localPosition ?? value.local_position ?? value.position, `node ${String(id)} localPosition`)
      };
    }
    if (Array.isArray(value) && value.length === 3) {
      const id = value[0];
      if (id === undefined || id === null || id === "") throw new ChainResolutionError(`node ${index} has no id`);
      return {
        id: String(id),
        parent: value[1] === undefined || value[1] === null || value[1] === "" ? null : String(value[1]),
        localPosition: vec3(value[2], `node ${String(id)} localPosition`)
      };
    }
    throw new ChainResolutionError(`node ${index} is not a joint node or mapping`);
  });
}

function childrenMap(nodes: JointNode[]): Record<string, string[]> {
  const children = Object.fromEntries(nodes.map((node) => [node.id, [] as string[]]));
  for (const node of nodes) {
    if (node.parent === null) continue;
    if (!(node.parent in children)) throw new ChainResolutionError(`joint ${node.id} has unresolved parent ${node.parent}`);
    children[node.parent]!.push(node.id);
  }
  return children;
}

function worldPositions(nodes: JointNode[]): Record<string, Vec3> {
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const world: Record<string, Vec3> = {};
  const resolve = (id: string, seen: Set<string>): Vec3 => {
    if (world[id]) return world[id]!;
    if (seen.has(id)) throw new ChainResolutionError(`cycle in the joint hierarchy through ${id}`);
    const node = byId[id];
    if (!node) throw new ChainResolutionError(`joint ${id} is missing`);
    const position = node.parent === null ? node.localPosition : add(resolve(node.parent, new Set([...seen, id])), node.localPosition);
    world[id] = position;
    return position;
  };
  for (const node of nodes) resolve(node.id, new Set());
  return world;
}

function descendToBranch(start: string, children: Record<string, string[]>): string[] {
  const path = [start];
  let current = start;
  while (children[current]!.length === 1) {
    current = children[current]![0]!;
    path.push(current);
  }
  return path;
}

function deepestLeafPath(start: string, children: Record<string, string[]>, world: Record<string, Vec3>): string[] {
  const walk = (id: string): { depth: number; length: number; path: string[] } => {
    const childrenAtNode = [...children[id]!].sort();
    if (childrenAtNode.length === 0) return { depth: 1, length: 0, path: [id] };
    let best: { depth: number; length: number; path: string[] } | undefined;
    for (const child of childrenAtNode) {
      const candidatePath = walk(child);
      const candidate = {
        depth: candidatePath.depth + 1,
        length: candidatePath.length + distance(world[id]!, world[child]!),
        path: [id, ...candidatePath.path]
      };
      if (!best || candidate.depth > best.depth || (candidate.depth === best.depth && candidate.length > best.length)) {
        best = candidate;
      }
    }
    return best!;
  };
  return walk(start).path;
}

function mirrorPairs(candidates: string[], local: Record<string, Vec3>, tolerance: number): { pairs: [string, string][]; unpaired: string[] } {
  const unused = [...candidates];
  const pairs: [string, string][] = [];
  while (unused.length > 0) {
    const first = unused.shift()!;
    const [x, y, z] = local[first]!;
    if (Math.abs(x) <= tolerance) continue;
    const match = unused.find((candidate) => {
      const [otherX, otherY, otherZ] = local[candidate]!;
      return Math.abs(x + otherX) <= tolerance && Math.abs(y - otherY) <= tolerance && Math.abs(z - otherZ) <= tolerance;
    });
    if (match !== undefined) {
      unused.splice(unused.indexOf(match), 1);
      pairs.push([first, match]);
    }
  }
  const paired = new Set(pairs.flat());
  return { pairs, unpaired: candidates.filter((candidate) => !paired.has(candidate)) };
}

export function resolveChains(input: Iterable<unknown>, sideLabels?: Record<string, string>, symmetryTolerance = SYMMETRY_TOLERANCE): Chains {
  const nodes = coerceNodes(input);
  if (nodes.length === 0) throw new ChainResolutionError("no joints supplied");
  const roots = nodes.filter((node) => node.parent === null).map((node) => node.id);
  if (roots.length !== 1) throw new ChainResolutionError(`expected exactly one root joint, found ${roots.length}: ${roots.sort().join(", ")}`);
  const children = childrenMap(nodes);
  const world = worldPositions(nodes);
  const local = Object.fromEntries(nodes.map((node) => [node.id, node.localPosition]));
  const notes: string[] = [];
  const hipPath = descendToBranch(roots[0]!, children);
  const hip = hipPath.at(-1)!;
  if (children[hip]!.length < 2) throw new ChainResolutionError(`no branch point below the root: ${hip} has no hip branch`);
  const hipPairs = mirrorPairs(children[hip]!, local, symmetryTolerance).pairs;
  const hipMedial = mirrorPairs(children[hip]!, local, symmetryTolerance).unpaired;
  if (hipPairs.length === 0) throw new ChainResolutionError(`hip branch ${hip} has no mirrored-X child pair within ${symmetryTolerance}; cannot resolve leg.l / leg.r`);
  hipPairs.sort((a, b) => Math.min(world[deepestLeafPath(a[0], children, world).at(-1)!]![1], world[deepestLeafPath(a[1], children, world).at(-1)!]![1]) - Math.min(world[deepestLeafPath(b[0], children, world).at(-1)!]![1], world[deepestLeafPath(b[1], children, world).at(-1)!]![1]));
  if (hipPairs.length > 1) notes.push(`hip branch ${hip} had ${hipPairs.length} mirrored pairs; took the lowest-leaved pair as the legs`);
  if (hipMedial.length === 0) throw new ChainResolutionError(`hip branch ${hip} has no medial child to continue the spine through`);
  hipMedial.sort((a, b) => world[deepestLeafPath(b, children, world).at(-1)!]![1] - world[deepestLeafPath(a, children, world).at(-1)!]![1]);
  const spineContinuation = hipMedial[0]!;
  const shoulderPath = descendToBranch(spineContinuation, children);
  const shoulder = shoulderPath.at(-1)!;
  if (children[shoulder]!.length < 2) throw new ChainResolutionError(`no shoulder branch above the hip: ${shoulder} cannot resolve arm.l / arm.r`);
  const armMirror = mirrorPairs(children[shoulder]!, local, symmetryTolerance);
  if (armMirror.pairs.length === 0) throw new ChainResolutionError(`shoulder branch ${shoulder} has no mirrored-X child pair within ${symmetryTolerance}; cannot resolve arm.l / arm.r`);
  armMirror.pairs.sort((a, b) => Math.min(world[a[0]]![1], world[a[1]]![1]) - Math.min(world[b[0]]![1], world[b[1]]![1]));
  if (armMirror.pairs.length > 1) notes.push(`shoulder branch ${shoulder} had ${armMirror.pairs.length} mirrored pairs; took the highest as the arms`);
  const shoulderMedial = armMirror.unpaired;
  if (shoulderMedial.length === 0) throw new ChainResolutionError(`shoulder branch ${shoulder} has no medial child to carry the spine to the head`);
  shoulderMedial.sort((a, b) => world[deepestLeafPath(b, children, world).at(-1)!]![1] - world[deepestLeafPath(a, children, world).at(-1)!]![1]);
  const spineIds = [...hipPath, ...shoulderPath, ...deepestLeafPath(shoulderMedial[0]!, children, world)];
  const sideOf = (pair: [string, string], group: string): Record<"l" | "r", string> => {
    if (sideLabels) {
      const resolved: Partial<Record<"l" | "r", string>> = {};
      for (const joint of pair) {
        const path = deepestLeafPath(joint, children, world);
        const label = path.map((id) => sideLabels[id]).find((candidate) => candidate !== undefined)?.toLowerCase().slice(0, 1) as "l" | "r" | undefined;
        if (label === "l" || label === "r") resolved[label] = joint;
      }
      if (resolved.l && resolved.r) return { l: resolved.l, r: resolved.r };
      throw new ChainResolutionError(`side_labels did not resolve both halves of the ${group} pair`);
    }
    const result = pair.reduce((mapping, joint) => {
      mapping[world[joint]![0] > 0 ? "l" : "r"] = joint;
      return mapping;
    }, {} as Partial<Record<"l" | "r", string>>);
    if (!result.l || !result.r) throw new ChainResolutionError(`a mirrored ${group} pair resolved to the same side`);
    return { l: result.l, r: result.r };
  };
  const legSides = sideOf(hipPairs[0]!, "leg");
  const armSides = sideOf(armMirror.pairs[0]!, "arm");
  const build = (name: string, anchor: string): Chain => {
    const jointIds = deepestLeafPath(anchor, children, world);
    return { name, jointIds, anchorPosition: world[anchor]!, anchor, leaf: jointIds.at(-1)! };
  };
  const sideSource = sideLabels ? "labels" : "model-x";
  if (!sideLabels) notes.push("no sideLabels supplied: left/right were assigned from model X, so the medial/lateral comparison is not independent");
  return {
    spine: { name: "spine", jointIds: spineIds, anchorPosition: world[roots[0]!]!, anchor: spineIds[0]!, leaf: spineIds.at(-1)! },
    arm: { l: build("arm.l", armSides.l), r: build("arm.r", armSides.r) },
    leg: { l: build("leg.l", legSides.l), r: build("leg.r", legSides.r) },
    worldPositions: world,
    sideSource,
    symmetryTolerance,
    notes,
    gateIsIndependent: sideSource === "labels"
  };
}

export function checkMedialLateral(chains: Chains, medialTolerance: number | undefined = MEDIAL_AXIS_TOLERANCE): string[] {
  const errors: string[] = [];
  for (const [group, mapping] of [["arm", chains.arm], ["leg", chains.leg]] as const) {
    const left = mapping.l;
    const right = mapping.r;
    const leftX = left.anchorPosition[0];
    const rightX = right.anchorPosition[0];
    if (!(leftX > 0)) errors.push(`MEDIAL_LATERAL: ${group}.l anchor ${left.anchor} has x=${leftX}, expected x > 0 (left is +X in model space)`);
    if (!(rightX < 0)) errors.push(`MEDIAL_LATERAL: ${group}.r anchor ${right.anchor} has x=${rightX}, expected x < 0 (right is -X in model space)`);
    if (leftX * rightX > 0) errors.push(`MEDIAL_LATERAL: ${group}.l (${leftX}) and ${group}.r (${rightX}) are on the same side of the midline`);
  }
  if (medialTolerance !== undefined) {
    for (const joint of [chains.spine.anchor, chains.spine.leaf]) {
      const x = chains.worldPositions[joint]![0];
      if (Math.abs(x) > medialTolerance) errors.push(`MEDIAL_AXIS: spine joint ${joint} has x=${x}, off the midline by more than ${medialTolerance}`);
    }
  }
  return errors;
}

export interface FeatureRange {
  lo?: number;
  hi?: number;
  hiExclusive: boolean;
  target?: number;
  units: string;
  source: string;
  contains(value: number): boolean;
  midpoint: number | undefined;
}

function featureRange(input: Omit<FeatureRange, "contains" | "midpoint">): FeatureRange {
  return {
    ...input,
    contains(value) {
      if (input.lo !== undefined && value < input.lo) return false;
      if (input.hi !== undefined && (input.hiExclusive ? value >= input.hi : value > input.hi)) return false;
      return true;
    },
    get midpoint() {
      if (input.target !== undefined) return input.target;
      if (input.lo !== undefined && input.hi !== undefined) return (input.lo + input.hi) / 2;
      return input.lo ?? input.hi;
    }
  };
}

export interface FeatureMiss {
  feature: string;
  value: number;
  side: "below" | "above";
  band: FeatureRange;
}

export interface BandCheck {
  bandName: string;
  inside: string[];
  outside: FeatureMiss[];
  unevaluated: Array<[string, string]>;
  ok: boolean;
  summary(): string;
  toJSON(): Record<string, unknown>;
}

export interface TargetBand {
  name: string;
  figureHeight: number;
  intendedClass: string;
  ranges: Record<string, FeatureRange>;
  limbFrame: string;
  notes: string[];
  contains(features: unknown): BandCheck;
  target(feature: string): number;
}

function featureValue(features: unknown, name: string): number | undefined {
  const aliases: Record<string, string[]> = {
    duration: ["duration"],
    travel: ["travel"],
    rise: ["rise"],
    speed: ["speed"],
    handRange: ["handRange", "hand_range"],
    footRange: ["footRange", "foot_range"],
    headRise: ["headRise", "head_rise"],
    scaleDelta: ["scaleDelta", "scale_delta"],
    poseReturn: ["poseReturn", "pose_return"],
    footSlide: ["footSlide", "foot_slide"],
    contact: ["contact", "contactFraction", "contact_fraction"]
  };
  const source = features as Record<string, unknown>;
  for (const alias of aliases[name] ?? [name]) {
    const value = source?.[alias];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value === null) return undefined;
  }
  return undefined;
}

export function targetBandContains(band: TargetBand, features: unknown): BandCheck {
  const inside: string[] = [];
  const outside: FeatureMiss[] = [];
  const unevaluated: Array<[string, string]> = [];
  for (const [name, range] of Object.entries(band.ranges)) {
    const value = featureValue(features, name);
    if (value === undefined) {
      unevaluated.push([name, "not present in the measured features"]);
    } else if (range.contains(value)) {
      inside.push(name);
    } else {
      outside.push({ feature: name, value, side: range.lo !== undefined && value < range.lo ? "below" : "above", band: range });
    }
  }
  return {
    bandName: band.name,
    inside,
    outside,
    unevaluated,
    ok: outside.length === 0,
    summary() {
      if (outside.length === 0 && unevaluated.length === 0) return `${band.name}: all ${inside.length} features inside band`;
      return `${band.name}: ${[
        ...(outside.length ? [`outside: ${outside.map((miss) => `${miss.feature}=${miss.value} is ${miss.side} its band`).join("; ")}`] : []),
        ...(unevaluated.length ? [`unevaluated: ${unevaluated.map(([name, reason]) => `${name} (${reason})`).join("; ")}`] : [])
      ].join(" | ")}`;
    },
    toJSON() {
      return {
        band: band.name,
        ok: outside.length === 0,
        inside,
        outside: outside.map((miss) => ({ ...miss, band: { ...miss.band, contains: undefined } })),
        unevaluated: unevaluated.map(([feature, reason]) => ({ feature, reason }))
      };
    }
  };
}

export function targetBandToJSON(band: TargetBand): Record<string, unknown> {
  return {
    name: band.name,
    figureHeight: band.figureHeight,
    intendedClass: band.intendedClass,
    limbFrame: band.limbFrame,
    ranges: Object.fromEntries(
      Object.entries(band.ranges).map(([name, range]) => [name, {
        lo: range.lo,
        hi: range.hi,
        hiExclusive: range.hiExclusive,
        target: range.target,
        units: range.units,
        source: range.source
      }])
    ),
    notes: band.notes
  };
}

function gaitBand(options: {
  name: string;
  intendedClass: string;
  figureHeight: number;
  durationLo: number;
  durationHi: number;
  speedLo: number;
  speedHi: number;
  speedTarget: number;
  riseLo: number;
  riseHi: number;
  handLo: number;
  handHi: number;
  handHiExclusive: boolean;
  handTarget: number;
  contactLo: number;
  contactHi: number;
  contactHiExclusive: boolean;
  contactTarget: number;
  footRangeTolerance: number;
  notes: string[];
}): TargetBand {
  const travelLo = options.speedTarget * options.durationLo;
  const travelHi = options.speedTarget * options.durationHi;
  const step = 0.25 * (travelLo + travelHi);
  const ranges: Record<string, FeatureRange> = {
    duration: featureRange({ lo: options.durationLo, hi: options.durationHi, hiExclusive: false, units: "s", source: "spec R4" }),
    speed: featureRange({ lo: options.speedLo, hi: options.speedHi, hiExclusive: true, target: options.speedTarget, units: "H/s", source: "spec classifier band" }),
    travel: featureRange({ lo: travelLo, hi: travelHi, hiExclusive: false, target: options.speedTarget * 0.5 * (options.durationLo + options.durationHi), units: "H", source: "speed x duration" }),
    rise: featureRange({ lo: options.riseLo, hi: options.riseHi, hiExclusive: false, units: "H", source: "spec R4" }),
    handRange: featureRange({ lo: options.handLo, hi: options.handHi, hiExclusive: options.handHiExclusive, target: options.handTarget, units: `H (${LIMB_FEATURE_FRAME})`, source: "spec R4 counter-swing" }),
    footRange: featureRange({ lo: step * (1 - options.footRangeTolerance), hi: step * (1 + options.footRangeTolerance), hiExclusive: false, target: step, units: `H (${LIMB_FEATURE_FRAME})`, source: "spec R4 travel/2" }),
    contact: featureRange({ lo: options.contactLo, hi: options.contactHi, hiExclusive: options.contactHiExclusive, target: options.contactTarget, units: "fraction of cycle per foot", source: "spec R4 contact" }),
    poseReturn: featureRange({ lo: 0, hi: POSE_RETURN_DEGREES, hiExclusive: false, units: "deg", source: "spec R4" }),
    scaleDelta: featureRange({ lo: 0, hi: 0, hiExclusive: false, units: "", source: "Gate R4" })
  };
  const band: TargetBand = {
    name: options.name,
    figureHeight: options.figureHeight,
    intendedClass: options.intendedClass,
    ranges,
    limbFrame: LIMB_FEATURE_FRAME,
    notes: options.notes,
    contains(features) {
      return targetBandContains(band, features);
    },
    target(feature) {
      const value = ranges[feature]?.midpoint;
      if (value === undefined) throw new Error(`band ${options.name} has no usable target for ${feature}`);
      return value;
    }
  };
  return band;
}

export function walkTargets(figureHeight: number): TargetBand {
  return gaitBand({
    name: "walk", intendedClass: "walk", figureHeight, durationLo: 1, durationHi: 1.2,
    speedLo: 0.3, speedHi: 0.6, speedTarget: 0.4, riseLo: 0.015, riseHi: 0.025,
    handLo: 0.15, handHi: 0.25, handHiExclusive: false, handTarget: 0.2,
    contactLo: 0.55, contactHi: 0.65, contactHiExclusive: false, contactTarget: 0.6,
    footRangeTolerance: FOOT_RANGE_TOLERANCE,
    notes: ["handRange and footRange are hip-relative, per-limb measurements", "contact 0.60 per foot puts both feet down 0.20 of the cycle"]
  });
}

export function runTargets(figureHeight: number): TargetBand {
  return gaitBand({
    name: "run", intendedClass: "run", figureHeight, durationLo: 1, durationHi: 1.2,
    speedLo: 0.6, speedHi: 1.5, speedTarget: 0.8, riseLo: 0.015, riseHi: 0.025,
    handLo: 0.25, handHi: 0.4, handHiExclusive: true, handTarget: 0.35,
    contactLo: 0.3, contactHi: 0.5, contactHiExclusive: true, contactTarget: 0.4,
    footRangeTolerance: FOOT_RANGE_TOLERANCE,
    notes: ["run changes speed, contact and handRange from the walk recipe", "contact 0.40 leaves a 0.20 flight phase"]
  });
}

export interface StanceSlide {
  landmark: string;
  interval: [number, number];
  contactTime: number;
  frames: number;
  maxSlide: number;
  maxSlideFraction: number;
  worstTime: number;
}

export interface FootSlideReport {
  figureHeight: number;
  limit: number;
  perStance: StanceSlide[];
  maxSlideFraction: number | null;
  status: Status;
  reason: string;
  unmeasured: string[];
  ok: boolean;
}

export function footSlide(
  landmarkPositions: Record<string, Array<Array<number>>>,
  sampleTimes: number[],
  stanceIntervals: Record<string, Array<Array<number>>>,
  figureHeight: number,
  limit = FOOT_SLIDE_LIMIT,
  timeTolerance = 1e-9
): FootSlideReport {
  if (figureHeight <= 0) throw new Error(`figureHeight must be positive, got ${figureHeight}`);
  const perStance: StanceSlide[] = [];
  const unmeasured: string[] = [];
  let considered = 0;
  for (const landmark of Object.keys(stanceIntervals).sort()) {
    const positions = landmarkPositions[landmark];
    if (!positions) {
      unmeasured.push(`${landmark}: stance intervals given but no landmark positions`);
      continue;
    }
    if (positions.length !== sampleTimes.length) throw new Error(`${landmark}: positions and sample times must have equal lengths`);
    for (const rawInterval of stanceIntervals[landmark]!) {
      if (rawInterval.length !== 2) throw new Error(`${landmark}: stance interval must have two endpoints`);
      considered += 1;
      const interval: [number, number] = [Number(rawInterval[0]), Number(rawInterval[1])];
      const frames = sampleTimes.map((time, index) => ({ time, index })).filter(({ time }) => time >= interval[0] - timeTolerance && time <= interval[1] + timeTolerance);
      if (frames.length < 2) {
        unmeasured.push(`${landmark} stance [${interval[0]}, ${interval[1]}]: ${frames.length} sample frame(s), too few to measure a slide`);
        continue;
      }
      const anchor = vec3(positions[frames[0]!.index], `${landmark}[${frames[0]!.index}]`);
      let worst = 0;
      let worstTime = frames[0]!.time;
      for (const frame of frames) {
        const slide = distance(vec3(positions[frame.index], `${landmark}[${frame.index}]`), anchor);
        if (slide > worst) {
          worst = slide;
          worstTime = frame.time;
        }
      }
      perStance.push({ landmark, interval, contactTime: frames[0]!.time, frames: frames.length, maxSlide: worst, maxSlideFraction: worst / figureHeight, worstTime });
    }
  }
  if (perStance.length === 0) {
    return { figureHeight, limit, perStance: [], maxSlideFraction: null, status: "unevaluated", reason: `no measurable stance interval: Gate G8 needs stance and at least two sample frames (${considered} considered)`, unmeasured, ok: false };
  }
  const maxSlideFraction = Math.max(...perStance.map((item) => item.maxSlideFraction));
  const worst = perStance.reduce((a, b) => (a.maxSlideFraction > b.maxSlideFraction ? a : b));
  const status = maxSlideFraction <= limit ? "pass" : "fail";
  return {
    figureHeight, limit, perStance, maxSlideFraction, status,
    reason: status === "pass" ? `footSlide ${maxSlideFraction}H <= ${limit}H over ${perStance.length} stance interval(s)` : `footSlide ${maxSlideFraction}H > ${limit}H — ${worst.landmark} slid ${worst.maxSlide} at t=${worst.worstTime}`,
    unmeasured,
    ok: status === "pass"
  };
}

export interface Primitive {
  name: string;
  use: string;
  parameters: string[];
  note: string;
}

export const PRIMITIVES: Record<string, Primitive> = {
  gait: { name: "Gait", use: "walk / run / dash", parameters: ["cadence", "stride", "contactFraction", "hipRise", "armCounterSwing"], note: "A phase machine with explicit stance windows." },
  ballistic: { name: "Ballistic", use: "jump / leap", parameters: ["takeoffVelocity", "apexRise", "flightTime", "landAbsorption"], note: "" },
  reach: { name: "Reach", use: "strike / gesture", parameters: ["targetSocket", "windupFraction", "followThrough", "return"], note: "Intent labels carry inferred: true." },
  additive: { name: "Additive", use: "breathing, sway", parameters: ["amplitude", "period", "jointMask"], note: "Layered on a base clip." }
};

export interface GaitPhase {
  leg: string;
  duration: number;
  contactFraction: number;
  stanceStartFraction: number;
  stanceIntervals(): Array<[number, number]>;
  swingIntervals(): Array<[number, number]>;
  plantIndex(time: number): [number, number];
  isStance(time: number, tolerance?: number): boolean;
}

function gaitPhase(leg: string, duration: number, contactFraction: number, stanceStartFraction: number): GaitPhase {
  const phase: GaitPhase = {
    leg, duration, contactFraction, stanceStartFraction,
    stanceIntervals() {
      const start = stanceStartFraction * duration;
      const end = start + contactFraction * duration;
      return end <= duration ? [[start, end]] : [[0, end - duration], [start, duration]];
    },
    swingIntervals() {
      const stance = phase.stanceIntervals();
      const result: Array<[number, number]> = [];
      let cursor = 0;
      for (const [lo, hi] of stance.sort((a, b) => a[0] - b[0])) {
        if (lo - cursor > 1e-12) result.push([cursor, lo]);
        cursor = Math.max(cursor, hi);
      }
      if (duration - cursor > 1e-12) result.push([cursor, duration]);
      return result;
    },
    plantIndex(time) {
      const u = time / duration - stanceStartFraction;
      const index = Math.floor(u);
      return [index, u - index];
    },
    isStance(time, tolerance = 1e-12) {
      return phase.plantIndex(time)[1] <= contactFraction + tolerance;
    }
  };
  return phase;
}

export interface GaitParameters {
  band: string;
  figureHeight: number;
  duration: number;
  cadence: number;
  speed: number;
  travel: number;
  stride: number;
  contactFraction: number;
  doubleSupportFraction: number;
  flightFraction: number;
  hipRise: number;
  armCounterSwing: number;
  footLift: number;
  phases: [GaitPhase, GaitPhase];
  phase(leg: string): GaitPhase;
  stanceIntervals(): Record<string, Array<Array<number>>>;
}

export function gaitParameters(band: TargetBand, figureHeight: number, footLiftFraction = FOOT_LIFT_FRACTION_OF_STRIDE): GaitParameters {
  const duration = band.target("duration");
  const speed = band.target("speed") * figureHeight;
  const travel = speed * duration;
  const contactFraction = band.target("contact");
  const overlap = 2 * contactFraction - 1;
  const phases: [GaitPhase, GaitPhase] = [gaitPhase("leg.l", duration, contactFraction, 0), gaitPhase("leg.r", duration, contactFraction, 0.5)];
  const result: GaitParameters = {
    band: band.name, figureHeight, duration, cadence: 2 / duration, speed, travel, stride: travel / 2,
    contactFraction, doubleSupportFraction: Math.max(0, overlap), flightFraction: Math.max(0, -overlap),
    hipRise: band.target("rise") * figureHeight, armCounterSwing: band.target("handRange") * figureHeight,
    footLift: footLiftFraction * (travel / 2), phases,
    phase(leg) {
      const found = phases.find((item) => item.leg === leg);
      if (!found) throw new Error(`unknown gait leg ${leg}`);
      return found;
    },
    stanceIntervals() {
      return Object.fromEntries(phases.map((item) => [`foot.${item.leg.split(".").at(-1)}`, item.stanceIntervals().map((interval) => [...interval])]));
    }
  };
  return result;
}

export function sampleTimes(duration: number, count = SAMPLE_COUNT, endpoint = false): number[] {
  if (count < 2) throw new Error(`need at least 2 samples, got ${count}`);
  const divisor = endpoint ? count - 1 : count;
  return Array.from({ length: count }, (_, index) => index * duration / divisor);
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

export function synthesiseGaitTracks(params: GaitParameters, count = SAMPLE_COUNT, endpoint = false, sourceName = "authored"): SampledClip {
  const times = sampleTimes(params.duration, count, endpoint);
  const plantZ = { l: 0.5 * params.contactFraction * params.travel, r: (0.5 + 0.5 * params.contactFraction) * params.travel };
  const lateralX = { l: FOOT_LATERAL_FRACTION * params.figureHeight, r: -FOOT_LATERAL_FRACTION * params.figureHeight };
  const positions: Record<string, Vec3[]> = Object.fromEntries(["hip", "head", "hand.l", "hand.r", "foot.l", "foot.r"].map((name) => [name, []])) as Record<string, Vec3[]>;
  for (const time of times) {
    const cycle = time / params.duration;
    const hipZ = params.speed * time;
    const hipY = HIP_HEIGHT_FRACTION * params.figureHeight + 0.5 * params.hipRise * Math.cos(4 * Math.PI * cycle);
    positions.hip!.push([0, hipY, hipZ]);
    positions.head!.push([0, HEAD_HEIGHT_FRACTION * params.figureHeight + 0.5 * params.hipRise * Math.cos(4 * Math.PI * cycle), hipZ]);
    for (const side of ["l", "r"] as const) {
      const phase = params.phase(`leg.${side}`);
      const [plant, fraction] = phase.plantIndex(time);
      const baseZ = plantZ[side] + plant * params.travel;
      const foot: Vec3 = fraction <= params.contactFraction + 1e-12
        ? [lateralX[side], 0, baseZ]
        : [lateralX[side], params.footLift * Math.sin(Math.PI * ((fraction - params.contactFraction) / (1 - params.contactFraction))), baseZ + params.travel * smoothstep((fraction - params.contactFraction) / (1 - params.contactFraction))];
      positions[`foot.${side}`]!.push(foot);
      const swing = 0.5 * params.armCounterSwing * Math.cos(2 * Math.PI * (cycle - phase.stanceStartFraction));
      positions[`hand.${side}`]!.push([ARM_LATERAL_FRACTION * params.figureHeight * (side === "l" ? 1 : -1), HAND_HEIGHT_FRACTION * params.figureHeight, hipZ - swing]);
    }
  }
  return {
    sourceName,
    duration: params.duration,
    sampleTimes: times,
    landmarkPositions: positions,
    jointScaleDelta: times.map(() => 0),
    poseReturn: 0,
    stance: params.stanceIntervals()
  };
}

export function buildPayload(clips: SampledClip[], figureHeight: number): Record<string, unknown> {
  return { figureHeight, landmarks: ["hip", "head", "hand.l", "hand.r", "foot.l", "foot.r"], clips };
}

export function hipRelativeClip(clip: SampledClip): SampledClip {
  const hip = clip.landmarkPositions.hip!;
  const origin = hip[0]!;
  const positions = Object.fromEntries(Object.entries(clip.landmarkPositions).map(([name, track]) => [
    name,
    track.map((point, index) => [point[0] - (hip[index]![0] - origin[0]), point[1], point[2] - (hip[index]![2] - origin[2])] as Vec3)
  ])) as Record<string, Vec3[]>;
  return { ...clip, landmarkPositions: positions, frame: "hip-relative" };
}

export function measuredContactFraction(clip: SampledClip): number | undefined {
  if (!clip.stance || !clip.duration) return undefined;
  const values = Object.values(clip.stance).map((intervals) => intervals.reduce((total, interval) => total + interval[1]! - interval[0]!, 0) / clip.duration);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

function perLimbRange(features: ClipFeatures, landmarks: readonly string[]): number | undefined {
  const values = landmarks.map((landmark) => features.landmarkRanges[landmark]).filter((value): value is Vec3 => value !== undefined).map((range) => Math.max(...range));
  return values.length ? Math.max(...values) : undefined;
}

export function bandFeatures(clip: SampledClip, figureHeight: number): Record<string, number> {
  const world = measureClip(clip as unknown as Record<string, unknown>, figureHeight);
  const relative = measureClip(hipRelativeClip(clip) as unknown as Record<string, unknown>, figureHeight);
  const values: Record<string, number> = {};
  for (const name of ["duration", "travel", "rise", "speed", "headRise", "scaleDelta", "poseReturn"] as const) {
    const value = world[name];
    if (typeof value === "number") values[name] = value;
  }
  for (const [name, landmarks] of [["handRange", ["hand.l", "hand.r"]], ["footRange", ["foot.l", "foot.r"]]] as const) {
    const value = perLimbRange(relative, landmarks);
    if (value !== undefined) values[name] = value;
  }
  const contact = measuredContactFraction(clip);
  if (contact !== undefined) values.contact = contact;
  return values;
}

export interface Criterion {
  criterion: string;
  status: Status;
  reason: string;
  detail?: Record<string, unknown>;
}

export interface Acceptance {
  gate: "R4";
  intendedClass: string;
  band: string;
  verdict: string;
  accepted: boolean;
  complete: boolean;
  criteria: Criterion[];
}

function criterion(name: string, status: Status, reason: string, detail?: Record<string, unknown>): Criterion {
  return { criterion: name, status, reason, ...(detail ? { detail } : {}) };
}

export function accepts(measuredFeatures: Record<string, unknown>, band: TargetBand, intendedClass: string, options: {
  classifierInput?: ClipFeatures;
  footSlideResult?: FootSlideReport;
  declaredLoop?: boolean;
  sourceRanges?: Record<string, [number, number]>;
  authoredRanges?: Record<string, [number, number]>;
  sourceScalesJoints?: boolean;
} = {}): Acceptance {
  const criteria: Criterion[] = [];
  const check = band.contains(measuredFeatures);
  criteria.push(criterion("band-containment", check.outside.length ? "fail" : check.unevaluated.length ? "unevaluated" : "pass", check.summary(), check.toJSON()));
  const classifierInput = options.classifierInput;
  if (!classifierInput) {
    criteria.push(criterion("classifier-agreement", "unevaluated", "no measured ClipFeatures supplied to the §2 classifier"));
  } else {
    const result = classify(classifierInput, DEFAULT_THRESHOLDS);
    const agrees = result.primary === intendedClass || result.labels.includes(intendedClass);
    criteria.push(criterion("classifier-agreement", agrees ? "pass" : "fail", `§2 classified the authored clip as ${JSON.stringify(result.primary)} (labels ${result.labels.join(", ")}), intended ${JSON.stringify(intendedClass)}`, { primary: result.primary, labels: result.labels, intended: intendedClass }));
  }
  const slide = options.footSlideResult ?? featureValue(measuredFeatures, "footSlide");
  if (typeof slide === "object" && slide !== null && "status" in slide) criteria.push(criterion("foot-slide", slide.status as Status, String(slide.reason), slide as unknown as Record<string, unknown>));
  else if (typeof slide === "number") criteria.push(criterion("foot-slide", slide <= FOOT_SLIDE_LIMIT ? "pass" : "fail", `footSlide ${slide}H vs limit ${FOOT_SLIDE_LIMIT}H`, { footSlide: slide, limit: FOOT_SLIDE_LIMIT }));
  else criteria.push(criterion("foot-slide", "unevaluated", "no footSlide measurement; a gait with no stance data has not been asked"));
  const scale = featureValue(measuredFeatures, "scaleDelta");
  criteria.push(scale === undefined
    ? criterion("no-joint-scale", "unevaluated", "no scaleDelta measurement")
    : scale === 0
      ? criterion("no-joint-scale", "pass", `scaleDelta = ${scale}, required exactly 0`, { scaleDelta: scale })
      : options.sourceScalesJoints
        ? criterion("no-joint-scale", "pass", `scaleDelta = ${scale}; sourceScalesJoints is explicitly declared`, { scaleDelta: scale, sourceScalesJoints: true })
        : criterion("no-joint-scale", "fail", `scaleDelta = ${scale}, required exactly 0`, { scaleDelta: scale }));
  const pose = featureValue(measuredFeatures, "poseReturn");
  if (options.declaredLoop === undefined || options.declaredLoop === false) criteria.push(criterion("pose-return-loop", "unevaluated", options.declaredLoop === false ? "clip is not declared a loop" : "clip does not declare whether it loops"));
  else criteria.push(pose === undefined ? criterion("pose-return-loop", "unevaluated", "clip is declared a loop but carries no poseReturn") : criterion("pose-return-loop", pose <= POSE_RETURN_DEGREES ? "pass" : "fail", `poseReturn ${pose} deg vs ${POSE_RETURN_DEGREES} deg`, { poseReturn: pose, limit: POSE_RETURN_DEGREES }));
  const source = options.sourceRanges;
  const authored = options.authoredRanges;
  if (!source) criteria.push(criterion("joint-range-vs-source", "unevaluated", "no source clips exist, so no measured joint range is available"));
  else if (!authored) criteria.push(criterion("joint-range-vs-source", "unevaluated", "source ranges supplied without authored ranges"));
  else {
    const violations = Object.entries(authored).filter(([joint, range]) => {
      const sourceRange = source[joint];
      return sourceRange !== undefined && (range[0] < sourceRange[0] || range[1] > sourceRange[1]);
    });
    criteria.push(criterion("joint-range-vs-source", violations.length ? "fail" : "pass", violations.length ? `${violations.length} joint(s) exceed source-measured ranges` : `all ${Object.keys(authored).length} joint(s) stayed inside source ranges`, { violations }));
  }
  const accepted = !criteria.some((item) => item.status === "fail");
  const complete = !criteria.some((item) => item.status === "unevaluated");
  return { gate: "R4", intendedClass, band: band.name, verdict: !accepted ? "rejected" : complete ? "accepted" : "accepted-with-unevaluated", accepted, complete, criteria };
}

export const walk_targets = walkTargets;
export const run_targets = runTargets;
export const foot_slide = footSlide;
export const gait_parameters = gaitParameters;
export const synthesise_gait_tracks = synthesiseGaitTracks;
export const hip_relative_clip = hipRelativeClip;
