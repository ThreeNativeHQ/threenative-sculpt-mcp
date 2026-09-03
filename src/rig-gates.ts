import {
  FOOT_SLIDE_LIMIT,
  MEDIAL_AXIS_TOLERANCE,
  checkMedialLateral,
  footSlide,
  resolveChains
} from "./action-design.js";
import { BIND_RESTORE_TOLERANCE, BINDING_EPSILON } from "./constants.js";
import { measureClip } from "./clip-features.js";
import {
  Manifest,
  STATUS_FAIL as PARITY_FAIL,
  STATUS_UNEVALUATED as PARITY_UNEVALUATED,
  FROZEN_BUFFERS,
  verify as verifyParity
} from "./mesh-parity.js";
import { SUPPORTED_INTERPOLATIONS } from "./glb-rig-reference.js";
import { SkinBinding, WEIGHT_SUM_TOLERANCE, validateBinding } from "./skin-conditioning.js";

export { BIND_RESTORE_TOLERANCE, BINDING_EPSILON } from "./constants.js";
export { FOOT_SLIDE_LIMIT, MEDIAL_AXIS_TOLERANCE } from "./action-design.js";
export const MINIMUM_GATE_R1_SAMPLES = 5;
export const MINIMUM_G2_VERTICES = 64;
export const MINIMUM_SWEEP_TIMES = 4;
export const MINIMUM_SWEEP_SIDES = 2;
export const MINIMUM_SWEEP_AZIMUTHS = 2;
export const STATUS_PASS = "pass";
export const STATUS_FAIL = "fail";
export const STATUS_UNEVALUATED = "unevaluated";

export interface SweepCoverage {
  times: number;
  sides: number;
  azimuths: number;
  provenance: string;
  requiredFrames(clipCount: number): number;
  toJSON(): Record<string, unknown>;
}

function sweepCoverage(
  times = MINIMUM_SWEEP_TIMES,
  sides = MINIMUM_SWEEP_SIDES,
  azimuths = MINIMUM_SWEEP_AZIMUTHS
): SweepCoverage {
  return {
    times,
    sides,
    azimuths,
    provenance: "single-subject (11 clips x 4 times x 2 sides x 2 azimuths = 176 frames)",
    requiredFrames(clipCount) {
      return Math.max(0, Math.trunc(clipCount)) * times * sides * azimuths;
    },
    toJSON() {
      return { times, sides, azimuths, provenance: this.provenance };
    }
  };
}

export const DEFAULT_SWEEP_COVERAGE = sweepCoverage();

export interface GateSpec {
  id: string;
  name: string;
  criterion: string;
  catches: string;
  inputKey: string;
}

export const GATE_SPECS: readonly GateSpec[] = [
  { id: "G1", name: "binding reaches node", criterion: "maxSampledBindingDelta <= 2^-23 over >= 5 times x all clips", catches: "clips that play silently", inputKey: "bindingSamples" },
  { id: "G2", name: "deformation finite", criterion: "applyBoneTransform on >= 64 vertices/mesh/frame, all finite", catches: "bad indices, NaN weights", inputKey: "deformation" },
  { id: "G3", name: "bind restore", criterion: "maxBindRestoreDelta <= 1e-12 after stop()", catches: "pose bleed between clips", inputKey: "bindRestore" },
  { id: "G4", name: "weights normalised", criterion: "|1 - sum(w)| <= 2e-7 every vertex", catches: "shrinking/inflating limbs", inputKey: "binding" },
  { id: "G5", name: "indices in range", criterion: "maxSkinIndex <= bones - 1", catches: "one vertex to infinity", inputKey: "binding" },
  { id: "G6", name: "every visible mesh bound", criterion: "visibleMeshCount == visibleSkinnedMeshCount", catches: "a part left behind in bind pose", inputKey: "meshVisibility" },
  { id: "G7", name: "medial/lateral", criterion: "leftAnchor.x > 0 > rightAnchor.x", catches: "mirrored rig", inputKey: "chainAnchors" },
  { id: "G8", name: "foot contact", criterion: "footSlide <= 0.01H in stance", catches: "skating gaits", inputKey: "clips[].stance" },
  { id: "G9", name: "no joint scale", criterion: "scaleDelta == 0 unless the source has it", catches: "weight-blend invalidation", inputKey: "clips" },
  { id: "G10", name: "skin integrity sweep", criterion: "background-through-split <= measured baseline", catches: "tearing under motion", inputKey: "skinIntegritySweep" },
  { id: "G11", name: "mesh parity", criterion: "every frozen buffer byte-identical after binding", catches: "rigging that rewrites mesh geometry", inputKey: "meshParity" },
  { id: "G12", name: "rig reference", criterion: "animation refers to the GLB's own skeleton, or an explicitly usable correspondence", catches: "clip channels and skinIndex values addressing a different skeleton", inputKey: "rigReference" }
] as const;

const SPECS = new Map(GATE_SPECS.map((spec) => [spec.id, spec]));

export interface GateResultValue {
  id: string;
  name: string;
  status: string;
  criterion: string;
  catches: string;
  threshold: unknown;
  measured: unknown;
  reason: string;
  details: Record<string, unknown>;
  warnings: string[];
}

export class GateResult implements GateResultValue {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly criterion: string;
  readonly catches: string;
  readonly threshold: unknown;
  readonly measured: unknown;
  readonly reason: string;
  readonly details: Record<string, unknown>;
  readonly warnings: string[];

  constructor(input: GateResultValue) {
    this.id = input.id;
    this.name = input.name;
    this.status = input.status;
    this.criterion = input.criterion;
    this.catches = input.catches;
    this.threshold = input.threshold;
    this.measured = input.measured;
    this.reason = input.reason;
    this.details = { ...input.details };
    this.warnings = [...input.warnings];
  }

  get passed(): boolean {
    return this.status === STATUS_PASS;
  }

  toJSON(): GateResultValue {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      criterion: this.criterion,
      catches: this.catches,
      threshold: this.threshold,
      measured: this.measured,
      reason: this.reason,
      details: { ...this.details },
      warnings: [...this.warnings]
    };
  }
}

export class GateReport {
  readonly results: GateResult[];
  readonly figureHeight: number | null;
  readonly sweepCoverage: SweepCoverage;

  constructor(results: GateResult[], figureHeight: number | null, coverage: SweepCoverage) {
    this.results = [...results];
    this.figureHeight = figureHeight;
    this.sweepCoverage = coverage;
  }

  get ok(): boolean {
    return this.results.length === GATE_SPECS.length && this.results.every((result) => result.passed);
  }

  byId(id: string): GateResult {
    const result = this.results.find((candidate) => candidate.id === id);
    if (!result) throw new Error(`no such gate: ${id}`);
    return result;
  }

  get failed(): GateResult[] {
    return this.results.filter((result) => result.status === STATUS_FAIL);
  }

  get unevaluated(): GateResult[] {
    return this.results.filter((result) => result.status === STATUS_UNEVALUATED);
  }

  summary(): Record<string, unknown> {
    return {
      ok: this.ok,
      figureHeight: this.figureHeight,
      counts: { total: this.results.length, pass: this.results.filter((result) => result.passed).length, fail: this.failed.length, unevaluated: this.unevaluated.length },
      failed: this.failed.map((result) => result.id),
      unevaluated: this.unevaluated.map((result) => result.id),
      sweepCoverage: this.sweepCoverage.toJSON(),
      rows: this.results.map((result) => ({ id: result.id, gate: result.name, status: result.status, measured: result.measured, threshold: result.threshold, catches: result.catches, reason: result.reason, warnings: result.warnings })),
      note: "ok is true only when every gate is pass. An unevaluated gate is not a pass."
    };
  }

  toJSON(): Record<string, unknown> {
    return { schemaVersion: 1, kind: "rig-gates", ok: this.ok, figureHeight: this.figureHeight, sweepCoverage: this.sweepCoverage.toJSON(), gates: this.results.map((result) => result.toJSON()), summary: this.summary() };
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function spec(id: string): GateSpec {
  const result = SPECS.get(id);
  if (!result) throw new Error(`gate spec ${id} is missing`);
  return result;
}

function unevaluated(id: string, reason: string, threshold: unknown, details: Json = {}): GateResult {
  const row = spec(id);
  return new GateResult({ id, name: row.name, status: STATUS_UNEVALUATED, criterion: row.criterion, catches: row.catches, threshold, measured: null, reason, details, warnings: [] });
}

function verdict(id: string, passed: boolean, threshold: unknown, measured: unknown, reason: string, warnings: string[] = [], details: Json = {}): GateResult {
  const row = spec(id);
  return new GateResult({ id, name: row.name, status: passed ? STATUS_PASS : STATUS_FAIL, criterion: row.criterion, catches: row.catches, threshold, measured, reason, details, warnings });
}

function clipRoster(payload: Json): string[] | null {
  const clips = payload.clips;
  if (Array.isArray(clips) && clips.length) {
    return clips.map((clip, index) => isRecord(clip) && typeof clip.sourceName === "string" ? clip.sourceName : `<clips[${index}] has no sourceName>`);
  }
  const names = payload.clipNames;
  return Array.isArray(names) && names.length && names.every((name) => typeof name === "string") ? names as string[] : null;
}

function normalizedSampledClips(raw: unknown): Map<string, Json> | null {
  const entries = new Map<string, Json>();
  if (isRecord(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isInteger(value)) entries.set(name, { sampleCount: value });
      else if (isRecord(value)) entries.set(name, { ...value, sampleCount: value.sampleCount });
      else return null;
    }
    return entries;
  }
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (!isRecord(value) || typeof value.sourceName !== "string") return null;
      entries.set(value.sourceName, value);
    }
    return entries;
  }
  return null;
}

export function gateG1(payload: Json): GateResult {
  const threshold = { maxSampledBindingDelta: BINDING_EPSILON, minimumSamplesPerClip: MINIMUM_GATE_R1_SAMPLES, clipCoverage: "every clip in the roster" };
  const block = payload.bindingSamples;
  if (!isRecord(block)) return unevaluated("G1", "payload has no bindingSamples block; the host harness did not run", threshold);
  const delta = block.maxSampledBindingDelta;
  if (!finite(delta)) return unevaluated("G1", "bindingSamples.maxSampledBindingDelta is missing or not finite", threshold);
  const roster = clipRoster(payload);
  if (!roster) return unevaluated("G1", "no independent clip roster: payload carries neither clips nor clipNames", threshold, { maxSampledBindingDelta: delta });
  const sampled = normalizedSampledClips(block.clips);
  if (!sampled) return unevaluated("G1", "bindingSamples.clips must be a per-clip sample-count map or list", threshold, { maxSampledBindingDelta: delta, clipsInRoster: roster.length });
  const missing = roster.filter((name) => !sampled.has(name));
  const thin: Record<string, number> = {};
  const unreadable: string[] = [];
  for (const name of roster) {
    const count = sampled.get(name)?.sampleCount;
    if (nonNegativeInt(count) === null) unreadable.push(name);
    else if ((count as number) < MINIMUM_GATE_R1_SAMPLES) thin[name] = count as number;
  }
  const extra = [...sampled.keys()].filter((name) => !roster.includes(name));
  const coverage = { clipsInRoster: roster.length, clipsSampled: roster.filter((name) => sampled.has(name)).length, minimumSamplesPerClip: MINIMUM_GATE_R1_SAMPLES, clipsMissing: missing, clipsUnderSampled: thin, clipsWithUnreadableSampleCount: unreadable, clipsNotInRoster: extra };
  const measured = { maxSampledBindingDelta: delta, coverage };
  const problems: string[] = [];
  if (!(delta <= BINDING_EPSILON)) problems.push(`maxSampledBindingDelta = ${delta} exceeds float32 epsilon ${BINDING_EPSILON}`);
  if (missing.length) problems.push(`the harness skipped ${missing.length} of ${roster.length} clips (${missing.join(", ")})`);
  if (Object.keys(thin).length) problems.push(`${Object.keys(thin).length} clip(s) sampled fewer than ${MINIMUM_GATE_R1_SAMPLES} times`);
  if (unreadable.length) problems.push(`${unreadable.length} clip(s) report no readable sampleCount (${unreadable.join(", ")})`);
  return verdict("G1", problems.length === 0, threshold, measured, problems.length ? problems.join("; ") : `maxSampledBindingDelta = ${delta} <= ${BINDING_EPSILON} over ${roster.length} clip(s), each sampled at least ${MINIMUM_GATE_R1_SAMPLES} times`, extra.length ? [`harness sampled clips absent from roster: ${extra.join(", ")}`] : []);
}

function frameCounts(value: unknown): { frames: number | null; counts: number[] | null } {
  if (!isRecord(value)) return { frames: null, counts: null };
  const frames = nonNegativeInt(value.frames);
  const vertices = value.verticesPerFrame;
  if (Array.isArray(vertices)) {
    const counts = vertices.map(nonNegativeInt);
    return counts.some((count) => count === null) ? { frames, counts: null } : { frames: frames ?? counts.length, counts: counts as number[] };
  }
  const count = nonNegativeInt(vertices);
  return frames === null || count === null ? { frames, counts: null } : { frames, counts: Array(frames).fill(count) };
}

export function gateG2(payload: Json): GateResult {
  const threshold = { allFinite: true, minimumVerticesPerMeshPerFrame: MINIMUM_G2_VERTICES, minimumFramesPerMesh: 1 };
  const block = payload.deformation;
  if (!isRecord(block)) return unevaluated("G2", "payload has no deformation block; applyBoneTransform runs in the host", threshold);
  const nonFinite = nonNegativeInt(block.nonFiniteCount);
  const allFinite = block.allFinite;
  if (nonFinite === null && typeof allFinite !== "boolean") return unevaluated("G2", "deformation reports neither nonFiniteCount nor allFinite", threshold);
  const meshes = block.meshes;
  if (!isRecord(meshes) || !Object.keys(meshes).length) return unevaluated("G2", "deformation.meshes must be a non-empty per-mesh coverage map", threshold, { nonFiniteCount: nonFinite });
  const perMesh: Json = {};
  const thin: string[] = [];
  const unreadable: string[] = [];
  for (const [name, entry] of Object.entries(meshes)) {
    const { frames, counts } = frameCounts(entry);
    if (frames === null || counts === null) {
      unreadable.push(name);
      perMesh[name] = { frames, minVerticesPerFrame: null };
      continue;
    }
    const smallest = counts.length ? Math.min(...counts) : 0;
    perMesh[name] = { frames, minVerticesPerFrame: smallest };
    if (frames < 1) thin.push(`${name} transformed over 0 frames`);
    else if (smallest < MINIMUM_G2_VERTICES) thin.push(`${name} transformed ${smallest} vertices in its thinnest frame`);
  }
  const measured = { nonFiniteCount: nonFinite, allFinite, meshes: perMesh, meshCount: Object.keys(meshes).length };
  const problems: string[] = [];
  if (nonFinite !== null && nonFinite > 0) problems.push(`${nonFinite} non-finite deformed vertex value(s)`);
  if (allFinite === false) problems.push("harness reports allFinite = false");
  if (thin.length) problems.push(`vertex coverage below ${MINIMUM_G2_VERTICES}/mesh/frame: ${thin.join("; ")}`);
  if (unreadable.length) problems.push(`mesh entries report no readable frames/verticesPerFrame: ${unreadable.join(", ")}`);
  return verdict("G2", problems.length === 0, threshold, measured, problems.length ? problems.join("; ") : `all deformed values finite over ${Object.keys(meshes).length} mesh(es)`);
}

export function gateG3(payload: Json): GateResult {
  const block = payload.bindRestore;
  const delta = isRecord(block) ? block.maxBindRestoreDelta : finite(block) ? block : undefined;
  if (!finite(delta)) return unevaluated("G3", "payload has no finite bindRestore.maxBindRestoreDelta; the host must measure stop()", BIND_RESTORE_TOLERANCE);
  return verdict("G3", delta <= BIND_RESTORE_TOLERANCE, BIND_RESTORE_TOLERANCE, delta, delta <= BIND_RESTORE_TOLERANCE ? `maxBindRestoreDelta = ${delta} <= ${BIND_RESTORE_TOLERANCE}` : `maxBindRestoreDelta = ${delta} exceeds ${BIND_RESTORE_TOLERANCE}`);
}

interface BindingVerdict { binding: SkinBinding | null; error: string | null; weightFailures: string[]; indexFailures: string[]; structuralFailures: string[]; }

function evaluateBinding(payload: Json): BindingVerdict | null {
  if (payload.binding === undefined || payload.binding === null) return null;
  let binding: SkinBinding;
  try { binding = payload.binding instanceof SkinBinding ? payload.binding : SkinBinding.fromJSON(payload.binding); }
  catch (error) { return { binding: null, error: `binding payload is unreadable: ${error instanceof Error ? error.message : String(error)}`, weightFailures: [], indexFailures: [], structuralFailures: [] }; }
  const failures = validateBinding(binding);
  return {
    binding,
    error: null,
    weightFailures: failures.filter((message) => message.includes("sum(w)") || message.includes("weight-sum")),
    indexFailures: failures.filter((message) => message.includes("skin index") || message.includes("index-range")),
    structuralFailures: failures.filter((message) => !message.includes("sum(w)") && !message.includes("weight-sum") && !message.includes("skin index") && !message.includes("index-range"))
  };
}

export function gateG4(payload: Json, checked?: BindingVerdict | null): GateResult {
  const binding = checked === undefined ? evaluateBinding(payload) : checked;
  if (!binding) return unevaluated("G4", "payload has no binding; weight normalisation cannot be checked", WEIGHT_SUM_TOLERANCE);
  if (binding.error) return unevaluated("G4", binding.error, WEIGHT_SUM_TOLERANCE);
  const measured = { verticesOutOfTolerance: binding.weightFailures.length, vertexCount: binding.binding?.vertexCount ?? null };
  const failures = [...binding.structuralFailures, ...binding.weightFailures];
  return verdict("G4", failures.length === 0, WEIGHT_SUM_TOLERANCE, measured, failures.length ? `skin conditioning rejected the binding: ${failures[0]}` : `no weight-sum failure across ${measured.vertexCount} vertices`, [], { delegatedTo: "skin_conditioning.validate_binding", delegatedFailures: failures });
}

export function gateG5(payload: Json, checked?: BindingVerdict | null): GateResult {
  const binding = checked === undefined ? evaluateBinding(payload) : checked;
  if (!binding) return unevaluated("G5", "payload has no binding; skin indices cannot be range-checked", { maxSkinIndex: "bones - 1" });
  if (binding.error) return unevaluated("G5", binding.error, { maxSkinIndex: "bones - 1" });
  const jointCount = binding.binding?.jointCount ?? null;
  const maxSkinIndex = binding.binding?.skinIndices.length
    ? binding.binding.skinIndices.reduce((maximum, value) => Math.max(maximum, value), 0)
    : null;
  const measured = { maxSkinIndex, boneCount: jointCount, slotsOutOfRange: binding.indexFailures.length };
  const failures = [...binding.structuralFailures, ...binding.indexFailures];
  return verdict("G5", failures.length === 0, { maxSkinIndex: jointCount === null ? "bones - 1" : jointCount - 1 }, measured, failures.length ? `skin conditioning rejected the binding: ${failures[0]}` : `maxSkinIndex = ${maxSkinIndex} <= ${(jointCount ?? 0) - 1}`, [], { delegatedTo: "skin_conditioning.validate_binding", delegatedFailures: failures });
}

export function gateG6(payload: Json): GateResult {
  const threshold = "visibleMeshCount == visibleSkinnedMeshCount";
  const block = payload.meshVisibility;
  if (!isRecord(block)) return unevaluated("G6", "payload has no meshVisibility block; the scene graph must be walked in the host", threshold);
  const visible = nonNegativeInt(block.visibleMeshCount);
  const skinned = nonNegativeInt(block.visibleSkinnedMeshCount);
  if (visible === null || skinned === null) return unevaluated("G6", "meshVisibility needs both counts as non-negative integers", threshold);
  const names = Array.isArray(block.unboundMeshes) ? block.unboundMeshes.map(String) : [];
  const measured = { visibleMeshCount: visible, visibleSkinnedMeshCount: skinned, unboundMeshes: names };
  const passed = visible === skinned && names.length === 0;
  return verdict("G6", passed, threshold, measured, passed ? `all ${visible} visible mesh(es) are skinned` : `${visible} visible mesh(es) but ${skinned} skinned; unbound list: ${names.join(", ") || "none"}`);
}

export function gateG7(payload: Json): GateResult {
  const threshold = "leftAnchor.x > 0 > rightAnchor.x";
  const block = payload.chainAnchors;
  if (!isRecord(block)) return unevaluated("G7", "payload has no chainAnchors block; the medial/lateral convention needs a hierarchy", threshold);
  const joints = block.joints;
  if (!Array.isArray(joints) || !joints.length) return unevaluated("G7", "chainAnchors.joints must be a non-empty hierarchy", threshold);
  try {
    const labels = isRecord(block.sideLabels) ? Object.fromEntries(Object.entries(block.sideLabels).map(([key, value]) => [key, String(value)])) : undefined;
    const chains = resolveChains(joints, labels, finite(block.symmetryTolerance) ? block.symmetryTolerance : undefined);
    const tolerance = finite(block.medialTolerance) ? block.medialTolerance : MEDIAL_AXIS_TOLERANCE;
    const errors = checkMedialLateral(chains, tolerance);
    const measured = { armLeftAnchorX: chains.arm.l.anchorPosition[0], armRightAnchorX: chains.arm.r.anchorPosition[0], legLeftAnchorX: chains.leg.l.anchorPosition[0], legRightAnchorX: chains.leg.r.anchorPosition[0], sideSource: chains.sideSource, gateIsIndependent: chains.gateIsIndependent };
    if (errors.length) return verdict("G7", false, threshold, measured, `action_design.check_medial_lateral rejected the rig: ${errors[0]}`, [], { delegatedTo: "action_design.check_medial_lateral", delegatedFailures: errors });
    if (!chains.gateIsIndependent) return unevaluated("G7", "left/right labels were assigned from model X, so the medial/lateral comparison is not independent; supply sideLabels", threshold, measured);
    return verdict("G7", true, threshold, measured, `left anchors are +X and right anchors are -X, checked against independent side labels`, [], { delegatedTo: "action_design.check_medial_lateral" });
  } catch (error) {
    return verdict("G7", false, threshold, null, `action_design.resolveChains could not resolve the chains: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function gateG8(payload: Json): GateResult {
  const threshold = { footSlide: FOOT_SLIDE_LIMIT, units: "fraction of figure height H" };
  const clips = payload.clips;
  if (!Array.isArray(clips) || !clips.length) return unevaluated("G8", "payload has no sampled-clip clips list; footSlide is measured on stance frames", threshold);
  const height = payload.figureHeight;
  if (!finite(height) || height <= 0) return unevaluated("G8", "payload.figureHeight must be finite and positive", threshold);
  const perClip: Json = {};
  const withoutStance: string[] = [];
  const unmeasured: string[] = [];
  const failing: string[] = [];
  let worst: number | null = null;
  let worstClip: string | null = null;
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    if (!isRecord(clip)) { unmeasured.push(`clips[${index}] is not an object`); continue; }
    const name = typeof clip.sourceName === "string" ? clip.sourceName : `clips[${index}]`;
    if (!isRecord(clip.stance) || !Object.keys(clip.stance).length) { withoutStance.push(name); continue; }
    if (!isRecord(clip.landmarkPositions) || !Array.isArray(clip.sampleTimes)) { unmeasured.push(`${name}: stance declared but positions/times are missing`); continue; }
    try {
      const report = footSlide(clip.landmarkPositions as Record<string, Array<Array<number>>>, clip.sampleTimes as number[], clip.stance as Record<string, Array<Array<number>>>, height, FOOT_SLIDE_LIMIT);
      perClip[name] = report;
      if (report.maxSlideFraction !== null && (worst === null || report.maxSlideFraction > worst)) { worst = report.maxSlideFraction; worstClip = name; }
      if (report.status === "fail") failing.push(`${name}: ${report.reason}`);
      if (report.status === "unevaluated") unmeasured.push(`${name}: ${report.reason}`);
    } catch (error) { unmeasured.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const measured = { maxFootSlideFraction: worst, worstClip, clipsMeasured: Object.keys(perClip).length, perClip };
  const warnings = [
    ...(withoutStance.length ? [`${withoutStance.length} clip(s) declare no stance intervals and were not gated: ${withoutStance.join(", ")}`] : []),
    ...(unmeasured.length ? [`unmeasurable stance data: ${unmeasured.join("; ")}`] : [])
  ];
  if (!Object.keys(perClip).length) return unevaluated("G8", `no clip carried a measurable stance interval; Gate G8 is an unasked question${withoutStance.length ? ` (clips without stance: ${withoutStance.join(", ")})` : ""}`, threshold, measured);
  return verdict("G8", failing.length === 0, threshold, measured, failing.length ? `${failing.length} clip(s) skate: ${failing.join("; ")}` : `footSlide ${worst ?? 0}H <= ${FOOT_SLIDE_LIMIT}H across ${Object.keys(perClip).length} clip(s)`, warnings, { clipsWithoutStance: withoutStance, delegatedTo: "action_design.footSlide" });
}

export function gateG9(payload: Json): GateResult {
  const declared = payload.sourceScalesJoints === true;
  const threshold = { scaleDelta: 0, sourceScalesJointsDeclared: declared };
  const clips = payload.clips;
  if (!Array.isArray(clips) || !clips.length) return unevaluated("G9", "payload has no sampled-clip clips list; scaleDelta cannot be assumed zero", threshold);
  const height = payload.figureHeight;
  if (!finite(height) || height <= 0) return unevaluated("G9", "payload.figureHeight must be finite and positive to measure clips", threshold);
  const byClip: Record<string, number> = {};
  try {
    for (const clip of clips) {
      const features = measureClip(clip as Json, height);
      byClip[features.sourceName] = features.scaleDelta;
    }
  } catch (error) { return unevaluated("G9", `clip measurement failed: ${error instanceof Error ? error.message : String(error)}`, threshold); }
  const scaling = Object.fromEntries(Object.entries(byClip).filter(([, value]) => value > 0));
  const measured = { maxScaleDelta: Math.max(...Object.values(byClip), 0), scaleDeltaByClip: byClip, clipsScaling: Object.keys(scaling) };
  if (!Object.keys(scaling).length) return verdict("G9", true, threshold, measured, `scaleDelta == 0 on ${Object.keys(byClip).length} clip(s); no joint is scaled`);
  const listed = Object.entries(scaling).map(([name, value]) => `${name} (${value})`).join(", ");
  if (declared) return verdict("G9", true, threshold, measured, `pass with warning: ${Object.keys(scaling).length} clip(s) scale joints and sourceScalesJoints is declared`, [`source rig scales joints on ${listed}; Stage R2 proximity blending is invalidated by scaled joints`]);
  return verdict("G9", false, threshold, measured, `scaleDelta > 0 on ${Object.keys(scaling).length} clip(s): ${listed}; sourceScalesJoints is not declared`);
}

const SWEEP_AXES = ["clips", "times", "sides", "azimuths"] as const;

export function gateG10(payload: Json, coverage = DEFAULT_SWEEP_COVERAGE): GateResult {
  const roster = clipRoster(payload);
  const threshold = { backgroundThroughSplitPx: "<= measured baseline", creasePx: "reported, never gated (see R2 trade)", minimumAxes: coverage.toJSON(), clipsInRoster: roster?.length ?? null };
  const block = payload.skinIntegritySweep;
  if (!isRecord(block)) return unevaluated("G10", "payload has no skinIntegritySweep block; an unrun visual sweep is not clean", threshold);
  const axes: Record<string, number> = {};
  const missing: string[] = [];
  for (const axis of SWEEP_AXES) {
    const value = nonNegativeInt(block[axis]);
    if (value === null) missing.push(axis); else axes[axis] = value;
  }
  const frames = nonNegativeInt(block.frames);
  if (missing.length || frames === null) return unevaluated("G10", `sweep is missing ${[...(frames === null ? ["frames"] : []), ...missing].join(", ")}; a bare total cannot show which axis was skipped`, threshold, { declaredFrames: frames, declaredAxes: axes });
  const holes = block.backgroundThroughSplitPx;
  const creases = block.creasePx;
  const baseline = isRecord(block.baseline) ? block.baseline.backgroundThroughSplitPx : undefined;
  const baselineCreases = isRecord(block.baseline) ? block.baseline.creasePx : undefined;
  if (!finite(holes)) return unevaluated("G10", "skinIntegritySweep.backgroundThroughSplitPx is missing or not finite", threshold, { declaredFrames: frames, declaredAxes: axes });
  if (!finite(baseline)) return unevaluated("G10", "skinIntegritySweep.baseline.backgroundThroughSplitPx is missing; the control run must be measured", threshold, { declaredFrames: frames, declaredAxes: axes, backgroundThroughSplitPx: holes });
  const product = axes.clips! * axes.times! * axes.sides! * axes.azimuths!;
  const targetClips = roster?.length ?? axes.clips!;
  const required = coverage.requiredFrames(targetClips);
  const measured = { backgroundThroughSplitPx: holes, backgroundThroughSplitBlobs: block.backgroundThroughSplitBlobs, creasePx: finite(creases) ? creases : null, baselineBackgroundThroughSplitPx: baseline, baselineCreasePx: finite(baselineCreases) ? baselineCreases : null, frames, axes, requiredFrames: required, note: "holes and creases are two numbers on purpose; Stage R2 trades one against the other" };
  const problems: string[] = [];
  if (frames !== product) problems.push(`sweep declares ${frames} frames but its axes multiply to ${product}`);
  if (axes.times! < coverage.times) problems.push(`times axis ${axes.times} is below ${coverage.times}`);
  if (axes.sides! < coverage.sides) problems.push(`sides axis ${axes.sides} is below ${coverage.sides}`);
  if (axes.azimuths! < coverage.azimuths) problems.push(`azimuths axis ${axes.azimuths} is below ${coverage.azimuths}`);
  if (roster && axes.clips! < roster.length) problems.push(`sweep covered ${axes.clips} of ${roster.length} clips`);
  if (frames < required) problems.push(`${frames} frames is below required ${required}`);
  if (!(holes <= baseline)) problems.push(`background through splits ${holes} px exceeds measured baseline ${baseline} px`);
  const warnings = [
    !finite(creases) ? "no creasePx reported; R2's hole/crease trade must remain visible" : "",
    finite(creases) && finite(baselineCreases) && creases > baselineCreases ? `creases rose from ${baselineCreases} px to ${creases} px; reported, not gated` : ""
  ].filter(Boolean);
  return verdict("G10", problems.length === 0, threshold, measured, problems.length ? problems.join("; ") : `background through splits ${holes} px <= baseline ${baseline} px over ${frames} frames`, warnings);
}

export function gateG11(payload: Json): GateResult {
  const threshold = { frozenBuffers: [...FROZEN_BUFFERS], criterion: "byte-identical over packed float64/int64", notFrozen: ["skinIndex", "skinWeight"] };
  const block = payload.meshParity;
  if (!isRecord(block)) return unevaluated("G11", "payload has no meshParity block; parity needs a freeze manifest and post-bind buffers", threshold);
  if (!isRecord(block.manifest) || !isRecord(block.after)) return unevaluated("G11", "meshParity is missing manifest or after; parity needs both halves", threshold, { manifestPresent: isRecord(block.manifest), afterPresent: isRecord(block.after) });
  let manifest: Manifest;
  try { manifest = block.manifest instanceof Manifest ? block.manifest : Manifest.fromJSON(block.manifest); }
  catch (error) { return unevaluated("G11", `freeze manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`, threshold); }
  let report;
  try { report = verifyParity(manifest, block.after); }
  catch (error) { return unevaluated("G11", `post-bind payload is unreadable: ${error instanceof Error ? error.message : String(error)}`, threshold); }
  const measured = { meshesFrozen: report.meshesFrozen, meshesCompared: report.meshesCompared, failureCount: report.failureCount, failures: report.failures.map((failure) => failure.toJSON()), addedLegalCount: report.additionCount, addedLegal: report.additions };
  const warnings = report.additions.length ? [`${report.additionCount} attribute(s) added and legal: ${report.additions.join(", ")}`] : [];
  if (report.status === PARITY_UNEVALUATED) return unevaluated("G11", `mesh parity could not evaluate: ${report.reason ?? "unknown reason"}`, threshold, measured);
  if (report.status === PARITY_FAIL) return verdict("G11", false, threshold, measured, `mesh parity reported ${report.failureCount} failure(s): ${report.failures[0]?.toString() ?? "no detail"}`, warnings, { delegatedTo: "mesh-parity.verify", summary: report.summary() });
  return verdict("G11", true, threshold, measured, `every frozen buffer is byte-identical across ${report.meshesCompared} frozen mesh(es)`, warnings, { delegatedTo: "mesh-parity.verify" });
}

export function gateG12(payload: Json): GateResult {
  const threshold = { source: "glb, or a correspondence with usable == true", structuralFailure: null, unsupportedInterpolationClips: [], supportedInterpolations: [...SUPPORTED_INTERPOLATIONS] };
  const block = payload.rigReference;
  if (!isRecord(block)) return unevaluated("G12", "payload has no rigReference block; no skeleton of record was supplied", threshold);
  const glb = block.glb;
  if (!isRecord(glb)) return unevaluated("G12", "rigReference carries no glb report", threshold);
  const structural = glb.structuralFailure;
  const unsupported = Array.isArray(glb.unsupportedInterpolationClips) ? glb.unsupportedInterpolationClips : [];
  const errors = Array.isArray(glb.errors) ? glb.errors : [];
  const declaredOk = glb.ok;
  const ok = typeof declaredOk === "boolean" ? declaredOk : !structural && !errors.length;
  const source = block.source;
  const primary = glb.primarySkinIndex;
  const correspondence = block.correspondence;
  const measured: Json = { source, glbOk: ok, okWasDeclared: typeof declaredOk === "boolean", primarySkinIndex: primary, structuralFailure: structural ?? null, unsupportedInterpolationClips: unsupported, errors, correspondenceUsable: isRecord(correspondence) ? correspondence.usable : null };
  if (typeof structural === "string" && structural) return verdict("G12", false, threshold, measured, `GLB has a structural failure: ${structural}`);
  if (unsupported.length) return verdict("G12", false, threshold, measured, `${unsupported.length} clip(s) use unsupported interpolation: ${unsupported.join(", ")}`);
  if (isRecord(correspondence)) {
    const usable = correspondence.usable === true;
    const unmatchedBones = Array.isArray(correspondence.unmatchedProceduralBones) ? correspondence.unmatchedProceduralBones : [];
    const unmatchedJoints = Array.isArray(correspondence.unmatchedGlbJoints) ? correspondence.unmatchedGlbJoints : [];
    measured.unmatchedProceduralBones = unmatchedBones;
    measured.unmatchedGlbJoints = unmatchedJoints;
    if (usable) return verdict("G12", true, threshold, measured, `explicit correspondence is usable: ${String(correspondence.reason ?? "all joints matched")}`);
    return verdict("G12", false, threshold, measured, `procedural-to-GLB correspondence is not usable; unmatched procedural bones ${unmatchedBones.join(", ") || "none"}, unmatched GLB joints ${unmatchedJoints.length}`);
  }
  if (source === "glb") {
    const problems = [
      ...(!ok ? [`GLB report is not ok${errors.length ? ` (${errors.join("; ")})` : ""}`] : []),
      ...(primary === null || primary === undefined ? ["report names no primary skin"] : [])
    ];
    return verdict("G12", problems.length === 0, threshold, measured, problems.length ? problems.join("; ") : `rig came straight from GLB primary skin ${primary}`);
  }
  return verdict("G12", false, threshold, measured, `rigReference declares source ${String(source)} without an explicit usable correspondence`);
}

export function runGates(payload: Json, coverage = DEFAULT_SWEEP_COVERAGE): GateReport {
  const binding = evaluateBinding(payload);
  const height = finite(payload.figureHeight) ? payload.figureHeight : null;
  const results = [gateG1(payload), gateG2(payload), gateG3(payload), gateG4(payload, binding), gateG5(payload, binding), gateG6(payload), gateG7(payload), gateG8(payload), gateG9(payload), gateG10(payload, coverage), gateG11(payload), gateG12(payload)];
  return new GateReport(results, height, coverage);
}

export const gate_g1 = gateG1;
export const gate_g2 = gateG2;
export const gate_g3 = gateG3;
export const gate_g4 = gateG4;
export const gate_g5 = gateG5;
export const gate_g6 = gateG6;
export const gate_g7 = gateG7;
export const gate_g8 = gateG8;
export const gate_g9 = gateG9;
export const gate_g10 = gateG10;
export const gate_g11 = gateG11;
export const gate_g12 = gateG12;
export const run_gates = runGates;
