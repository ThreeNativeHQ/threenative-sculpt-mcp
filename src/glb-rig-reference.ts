import { readFileSync } from "node:fs";

export const CORRESPONDENCE_TOLERANCE = 0.05;
export const DEFAULT_SAMPLE_COUNT = 25;
export const SLERP_EPSILON = 1e-9;
export const SCALE_UNIT_EPSILON = 0;
export const TRS_PATHS = ["translation", "rotation", "scale"] as const;
export const ANIMATION_PATHS = [...TRS_PATHS, "weights"] as const;
export const SUPPORTED_INTERPOLATIONS = ["STEP", "LINEAR"] as const;
export const INVERSE_BIND_OMITTED = "omitted-defaults-to-identity";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Mat4 = number[];
type JsonRecord = Record<string, unknown>;

export class UnsupportedInterpolation extends Error {
  readonly clipName: string;
  readonly interpolation: string;

  constructor(clipName: string, interpolation: string, detail = "") {
    super(`clip ${JSON.stringify(clipName)} uses ${interpolation} interpolation, which this module does not evaluate; it is reported unsupported rather than approximated as LINEAR${detail ? ` (${detail})` : ""}`);
    this.name = "UnsupportedInterpolation";
    this.clipName = clipName;
    this.interpolation = interpolation;
  }
}

export const IDENTITY_MATRIX: Mat4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function jsonDocument(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("GLB JSON chunk must be an object");
  return value;
}

export function parseGlb(filePath: string): { document: JsonRecord; bin: Buffer } {
  const bytes = readFileSync(filePath);
  if (bytes.length < 12) throw new Error("GLB is truncated before its 12-byte header");
  if (bytes.toString("ascii", 0, 4) !== "glTF") throw new Error("GLB header magic is not glTF");
  const version = bytes.readUInt32LE(4);
  if (version !== 2) throw new Error(`GLB version ${version} is not 2`);
  const declaredLength = bytes.readUInt32LE(8);
  if (declaredLength > bytes.length) throw new Error(`GLB is truncated: declares ${declaredLength} bytes but only ${bytes.length} exist`);
  let offset = 12;
  let document: JsonRecord | undefined;
  let bin = Buffer.alloc(0);
  while (offset < declaredLength) {
    if (offset + 8 > declaredLength) throw new Error("GLB is truncated in a chunk header");
    const chunkLength = bytes.readUInt32LE(offset);
    const chunkType = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + chunkLength > declaredLength || offset + chunkLength > bytes.length) throw new Error("GLB is truncated in a chunk payload");
    const chunk = bytes.subarray(offset, offset + chunkLength);
    if (chunkType === 0x4e4f534a) {
      const text = chunk.toString("utf8").replace(/[\u0000\u0020]+$/g, "");
      document = jsonDocument(JSON.parse(text));
    } else if (chunkType === 0x004e4942 && bin.length === 0) {
      bin = Buffer.from(chunk);
    }
    offset += chunkLength;
  }
  if (!document) throw new Error("GLB has no JSON chunk");
  return { document, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function normaliseComponent(componentType: number, value: number): number {
  if (componentType === 5120) return Math.max(value / 127, -1);
  if (componentType === 5121) return value / 255;
  if (componentType === 5122) return Math.max(value / 32767, -1);
  if (componentType === 5123) return value / 65535;
  return value;
}

function readComponent(view: DataView, offset: number, componentType: number): number {
  switch (componentType) {
    case 5120: return view.getInt8(offset);
    case 5121: return view.getUint8(offset);
    case 5122: return view.getInt16(offset, true);
    case 5123: return view.getUint16(offset, true);
    case 5125: return view.getUint32(offset, true);
    case 5126: return view.getFloat32(offset, true);
    default: throw new Error(`accessor uses unsupported componentType ${componentType}`);
  }
}

export function readAccessor(document: JsonRecord, bin: Buffer, index: number): number[][] {
  const accessors = document.accessors;
  if (!Array.isArray(accessors) || !isRecord(accessors[index])) throw new Error(`missing accessor ${index}`);
  const accessor = accessors[index] as JsonRecord;
  if (accessor.sparse !== undefined) throw new Error(`accessor ${index} uses sparse storage, which this reader does not decode`);
  const type = accessor.type;
  const components = typeof type === "string" ? COMPONENTS[type] : undefined;
  if (!components) throw new Error(`accessor ${index} has unsupported type ${String(type)}`);
  const componentType = typeof accessor.componentType === "number" ? accessor.componentType : 5126;
  const componentBytes = COMPONENT_BYTES[componentType];
  if (!componentBytes) throw new Error(`accessor ${index} has unsupported componentType ${componentType}`);
  const count = typeof accessor.count === "number" ? accessor.count : 0;
  if (!Number.isInteger(count) || count < 0) throw new Error(`accessor ${index} has an invalid count`);
  if (accessor.bufferView === undefined) return Array.from({ length: count }, () => Array.from({ length: components }, () => 0));
  const views = document.bufferViews;
  const viewIndex = accessor.bufferView;
  if (!Array.isArray(views) || typeof viewIndex !== "number" || !isRecord(views[viewIndex])) throw new Error(`accessor ${index} references missing bufferView`);
  const bufferView = views[viewIndex] as JsonRecord;
  const start = typeof bufferView.byteOffset === "number" ? bufferView.byteOffset : 0;
  const length = typeof bufferView.byteLength === "number" ? bufferView.byteLength : 0;
  if (start < 0 || length < 0 || start + length > bin.length) throw new Error(`bufferView ${viewIndex} exceeds the GLB BIN chunk`);
  const bytes = bin.subarray(start, start + length);
  const elementBytes = componentBytes * components;
  const stride = typeof bufferView.byteStride === "number" ? bufferView.byteStride : elementBytes;
  if (stride < elementBytes) throw new Error(`bufferView stride ${stride} is too small for accessor ${index}`);
  const base = typeof accessor.byteOffset === "number" ? accessor.byteOffset : 0;
  const normalised = accessor.normalized === true;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, element) => {
    const elementOffset = base + element * stride;
    if (elementOffset < 0 || elementOffset + elementBytes > bytes.length) throw new Error(`accessor ${index} element ${element} exceeds its bufferView`);
    return Array.from({ length: components }, (_, component) => {
      const value = readComponent(view, elementOffset + component * componentBytes, componentType);
      return normalised ? normaliseComponent(componentType, value) : value;
    });
  });
}

export function composeTrs(translation: Vec3, rotation: Quat, scale: Vec3): Mat4 {
  const [x, y, z, w] = rotation;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = scale;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    translation[0], translation[1], translation[2], 1
  ];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = Array.from({ length: 16 }, () => 0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] = [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row]! * b[column * 4 + k]!, 0);
    }
  }
  return out;
}

export function matrixTranslation(matrix: Mat4): Vec3 {
  return [matrix[12]!, matrix[13]!, matrix[14]!];
}

export function normalizeQuat(input: Quat): Quat {
  const length = Math.hypot(...input);
  return length === 0 ? [0, 0, 0, 1] : input.map((value) => value / length) as Quat;
}

export function decompose(matrix: Mat4): { translation: Vec3; rotation: Quat; scale: Vec3 } {
  const sx = Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!);
  const sy = Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!);
  const sz = Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!);
  const determinant = matrix[0]! * (matrix[5]! * matrix[10]! - matrix[9]! * matrix[6]!) - matrix[4]! * (matrix[1]! * matrix[10]! - matrix[9]! * matrix[2]!) + matrix[8]! * (matrix[1]! * matrix[6]! - matrix[5]! * matrix[2]!);
  const signedX = determinant < 0 ? -sx : sx;
  const m11 = matrix[0]! / (signedX || 1), m21 = matrix[1]! / (signedX || 1), m31 = matrix[2]! / (signedX || 1);
  const m12 = matrix[4]! / (sy || 1), m22 = matrix[5]! / (sy || 1), m32 = matrix[6]! / (sy || 1);
  const m13 = matrix[8]! / (sz || 1), m23 = matrix[9]! / (sz || 1), m33 = matrix[10]! / (sz || 1);
  const trace = m11 + m22 + m33;
  let rotation: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    rotation = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    rotation = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    rotation = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    rotation = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  return { translation: [matrix[12]!, matrix[13]!, matrix[14]!], rotation: normalizeQuat(rotation), scale: [signedX, sy, sz] };
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  if (t <= 0) return a;
  if (t >= 1) return b;
  let target = b;
  let cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (cosine < 0) {
    target = b.map((value) => -value) as Quat;
    cosine = -cosine;
  }
  if (cosine >= 1 - SLERP_EPSILON) return normalizeQuat(a.map((value, index) => value + (target[index]! - value) * t) as Quat);
  const sine = Math.sqrt(1 - cosine * cosine);
  const halfTheta = Math.atan2(sine, cosine);
  const ratioA = Math.sin((1 - t) * halfTheta) / sine;
  const ratioB = Math.sin(t * halfTheta) / sine;
  return normalizeQuat(a.map((value, index) => value * ratioA + target[index]! * ratioB) as Quat);
}

export function quaternionAngleDegrees(a: Quat, b: Quat): number {
  const first = normalizeQuat(a);
  const second = normalizeQuat(b);
  const dot = Math.min(1, Math.max(-1, Math.abs(first[0] * second[0] + first[1] * second[1] + first[2] * second[2] + first[3] * second[3])));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

export interface GlbJoint {
  skinJointIndex: number;
  nodeIndex: number;
  nodeName: string;
  parentNodeIndex: number | null;
}

export interface GlbSkinRecord {
  skinIndex: number;
  name: string;
  skeletonNodeIndex: number | null;
  joints: GlbJoint[];
  inverseBindMatrices: Mat4[];
  inverseBindSource: string;
}

export interface GlbChannel {
  animationIndex: number;
  channelIndex: number;
  samplerIndex: number;
  targetNodeIndex: number | null;
  path: string;
  interpolation: string;
  keyCount: number;
  timeMin: number;
  timeMax: number;
}

export interface GlbClip {
  animationIndex: number;
  name: string;
  channels: GlbChannel[];
  duration: number;
  interpolations: string[];
}

export class GlbRig {
  readonly path: string;
  readonly nodeCount: number;
  readonly nodes: JsonRecord[];
  readonly skins: GlbSkinRecord[];
  primarySkin: GlbSkinRecord | null;
  readonly skinnedMeshNodes: JsonRecord[];
  readonly clips: GlbClip[];
  deformVsTechnical: JsonRecord;
  structuralFailure: string | null;
  readonly warnings: string[];
  readonly document: JsonRecord;
  readonly bin: Buffer;
  readonly parents: Record<number, number | null>;

  constructor(input: {
    path: string;
    nodes: JsonRecord[];
    skins: GlbSkinRecord[];
    primarySkin: GlbSkinRecord | null;
    skinnedMeshNodes: JsonRecord[];
    clips: GlbClip[];
    deformVsTechnical: JsonRecord;
    structuralFailure: string | null;
    warnings: string[];
    document: JsonRecord;
    bin: Buffer;
    parents: Record<number, number | null>;
  }) {
    this.path = input.path;
    this.nodeCount = input.nodes.length;
    this.nodes = input.nodes;
    this.skins = input.skins;
    this.primarySkin = input.primarySkin;
    this.skinnedMeshNodes = input.skinnedMeshNodes;
    this.clips = input.clips;
    this.deformVsTechnical = input.deformVsTechnical;
    this.structuralFailure = input.structuralFailure;
    this.warnings = input.warnings;
    this.document = input.document;
    this.bin = input.bin;
    this.parents = input.parents;
  }

  get joints(): GlbJoint[] { return this.primarySkin?.joints ?? []; }
  get inverseBindMatrices(): Mat4[] { return this.primarySkin?.inverseBindMatrices ?? []; }
  get inverseBindSource(): string | null { return this.primarySkin?.inverseBindSource ?? null; }
  get unsupportedInterpolationClips(): string[] {
    return this.clips.filter((clip) => clip.channels.some((channel) => TRS_PATHS.includes(channel.path as typeof TRS_PATHS[number]) && !SUPPORTED_INTERPOLATIONS.includes(channel.interpolation as typeof SUPPORTED_INTERPOLATIONS[number]))).map((clip) => clip.name);
  }
  nodeName(index: number): string { return this.nodes[index]?.name as string ?? `node-${index}`; }
  toJSON(): JsonRecord {
    return {
      schemaVersion: 1,
      kind: "glb-rig-reference",
      path: this.path,
      nodeCount: this.nodeCount,
      skinCount: this.skins.length,
      clipCount: this.clips.length,
      primarySkinIndex: this.primarySkin?.skinIndex ?? null,
      skins: this.skins.map((skin) => ({ ...skin, jointCount: skin.joints.length, jointOrder: "skin.joints (§R0.3: the ordering is the skin's, never the traversal's)" })),
      joints: this.joints,
      inverseBindSource: this.inverseBindSource,
      inverseBindMatrices: this.inverseBindMatrices,
      skinnedMeshNodes: this.skinnedMeshNodes,
      clips: this.clips,
      deformVsTechnical: this.deformVsTechnical,
      unsupportedInterpolationClips: this.unsupportedInterpolationClips,
      structuralFailure: this.structuralFailure,
      warnings: this.warnings,
      note: "Joint order is skin.joints order; animation channels address GLB node indices and JOINTS_0 addresses this joint array."
    };
  }
}

function nodeList(document: JsonRecord): JsonRecord[] {
  return Array.isArray(document.nodes) ? document.nodes.map((node) => isRecord(node) ? node : {}) : [];
}

function parentMap(nodes: JsonRecord[]): Record<number, number | null> {
  const parents: Record<number, number | null> = Object.fromEntries(nodes.map((_, index) => [index, null]));
  nodes.forEach((node, index) => {
    if (!Array.isArray(node.children)) return;
    for (const child of node.children) if (typeof child === "number" && child >= 0 && child < nodes.length) parents[child] = index;
  });
  return parents;
}

function deformVsTechnical(skins: GlbSkinRecord[], primary: GlbSkinRecord | null, clips: GlbClip[], nodes: JsonRecord[]): JsonRecord {
  const targeted = new Map<number, number>();
  let channelsWithoutTargetNode = 0;
  for (const clip of clips) for (const channel of clip.channels) {
    if (channel.targetNodeIndex === null) channelsWithoutTargetNode += 1;
    else targeted.set(channel.targetNodeIndex, (targeted.get(channel.targetNodeIndex) ?? 0) + 1);
  }
  if (skins.length === 0) return { status: "unevaluated", reason: "GLB carries no skin, so node membership has no answer", basis: null, targetedNodeCount: targeted.size, channelsWithoutTargetNode, deformNodes: [], technicalNodes: [], channelsTargetingJoints: null, channelsTargetingTechnicalNodes: null };
  const jointNodes = new Set((primary ? primary.joints : skins.flatMap((skin) => skin.joints)).map((joint) => joint.nodeIndex));
  const deformNodes: JsonRecord[] = [], technicalNodes: JsonRecord[] = [];
  let deformChannels = 0, technicalChannels = 0;
  for (const [nodeIndex, channelCount] of [...targeted.entries()].sort((a, b) => a[0] - b[0])) {
    const entry = { nodeIndex, nodeName: nodes[nodeIndex]?.name ?? `node-${nodeIndex}`, channelCount };
    if (jointNodes.has(nodeIndex)) { deformNodes.push(entry); deformChannels += channelCount; }
    else { technicalNodes.push(entry); technicalChannels += channelCount; }
  }
  return { status: "evaluated", reason: null, basis: primary ? `primarySkin:${primary.skinIndex}` : "unionOfAllSkins", rule: "a node is a Bone iff it appears in skin.joints; never inferred from names", targetedNodeCount: targeted.size, channelsWithoutTargetNode, deformNodes, technicalNodes, channelsTargetingJoints: deformChannels, channelsTargetingTechnicalNodes: technicalChannels };
}

export function readRig(filePath: string): GlbRig {
  const path = filePath;
  const parsed = parseGlb(path);
  const document = parsed.document;
  const nodes = nodeList(document);
  const parents = parentMap(nodes);
  const nodeRecords = nodes.map((node, index) => ({ index, name: node.name ?? `node-${index}`, parentNodeIndex: parents[index] ?? null, children: Array.isArray(node.children) ? node.children.filter((child): child is number => typeof child === "number") : [], mesh: node.mesh, skin: node.skin }));
  const warnings: string[] = [];
  const skins: GlbSkinRecord[] = [];
  const rawSkins = Array.isArray(document.skins) ? document.skins : [];
  for (let skinIndex = 0; skinIndex < rawSkins.length; skinIndex += 1) {
    const raw = rawSkins[skinIndex];
    if (!isRecord(raw)) { warnings.push(`skin ${skinIndex} is not an object and was skipped`); continue; }
    const rawJoints = Array.isArray(raw.joints) ? raw.joints : [];
    const joints = rawJoints.map((rawNode, slot) => {
      const nodeIndex = Number(rawNode);
      return { skinJointIndex: slot, nodeIndex, nodeName: nodes[nodeIndex]?.name as string ?? `node-${nodeIndex}`, parentNodeIndex: parents[nodeIndex] ?? null };
    });
    let inverseBindMatrices: Mat4[];
    let inverseBindSource: string;
    if (raw.inverseBindMatrices === undefined) {
      inverseBindMatrices = joints.map(() => [...IDENTITY_MATRIX]);
      inverseBindSource = INVERSE_BIND_OMITTED;
    } else {
      try { inverseBindMatrices = readAccessor(document, parsed.bin, Number(raw.inverseBindMatrices)); }
      catch (error) { warnings.push(`skin ${skinIndex}: ${error instanceof Error ? error.message : String(error)}`); inverseBindMatrices = []; }
      if (inverseBindMatrices.length !== joints.length) warnings.push(`skin ${skinIndex} has ${joints.length} joints but ${inverseBindMatrices.length} inverse-bind matrices; pairing is not trustworthy`);
      inverseBindMatrices = joints.map((_, index) => inverseBindMatrices[index]?.length === 16 ? inverseBindMatrices[index]! : [...IDENTITY_MATRIX]);
      inverseBindSource = `accessor:${Number(raw.inverseBindMatrices)}`;
    }
    skins.push({ skinIndex, name: typeof raw.name === "string" ? raw.name : `skin-${skinIndex}`, skeletonNodeIndex: typeof raw.skeleton === "number" ? raw.skeleton : null, joints, inverseBindMatrices, inverseBindSource });
  }
  const primary = skins.length === 1 ? skins[0]! : null;
  let structuralFailure: string | null = null;
  if (skins.length === 0) structuralFailure = "GLB carries no skin, so it has no rig to reference";
  else if (skins.length > 1) structuralFailure = `GLB carries ${skins.length} skins and no primary skin was chosen; name one skin because each skin owns its own joint index space`;
  const skinnedMeshNodes = nodeRecords.filter((node) => typeof node.mesh === "number" && typeof node.skin === "number");
  const clips: GlbClip[] = [];
  const rawAnimations = Array.isArray(document.animations) ? document.animations : [];
  for (let animationIndex = 0; animationIndex < rawAnimations.length; animationIndex += 1) {
    const animation = rawAnimations[animationIndex];
    if (!isRecord(animation)) { warnings.push(`animation ${animationIndex} is not an object and was skipped`); continue; }
    const samplers = Array.isArray(animation.samplers) ? animation.samplers : [];
    const channels: GlbChannel[] = [];
    for (let channelIndex = 0; channelIndex < (Array.isArray(animation.channels) ? animation.channels.length : 0); channelIndex += 1) {
      const channel = (animation.channels as unknown[])[channelIndex];
      if (!isRecord(channel)) continue;
      const target = isRecord(channel.target) ? channel.target : {};
      const samplerIndex = typeof channel.sampler === "number" ? channel.sampler : -1;
      let interpolation = "LINEAR", keyCount = 0, timeMin = 0, timeMax = 0;
      const sampler = isRecord(samplers[samplerIndex]) ? samplers[samplerIndex] as JsonRecord : undefined;
      if (!sampler) warnings.push(`animation ${animationIndex} channel ${channelIndex} references missing sampler ${String(channel.sampler)}`);
      if (sampler) {
        interpolation = typeof sampler.interpolation === "string" ? sampler.interpolation : "LINEAR";
        if (typeof sampler.input === "number") {
          try {
            const times = readAccessor(document, parsed.bin, sampler.input).map((value) => value[0]!);
            keyCount = times.length;
            if (times.length) { timeMin = Math.min(...times); timeMax = Math.max(...times); }
          } catch (error) { warnings.push(`animation ${animationIndex} channel ${channelIndex}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      }
      channels.push({ animationIndex, channelIndex, samplerIndex, targetNodeIndex: typeof target.node === "number" ? target.node : null, path: typeof target.path === "string" ? target.path : "unknown", interpolation, keyCount, timeMin, timeMax });
    }
    clips.push({ animationIndex, name: typeof animation.name === "string" ? animation.name : `animation-${animationIndex}`, channels, duration: Math.max(0, ...channels.map((channel) => channel.timeMax)), interpolations: [...new Set(channels.map((channel) => channel.interpolation))].sort() });
  }
  const deform = deformVsTechnical(skins, primary, clips, nodeRecords);
  if (typeof deform.channelsTargetingTechnicalNodes === "number" && deform.channelsTargetingTechnicalNodes > 0) warnings.push(`${deform.channelsTargetingTechnicalNodes} animation channels target technical nodes that are not in skin.joints`);
  return new GlbRig({ path, nodes: nodeRecords, skins, primarySkin: primary, skinnedMeshNodes, clips, deformVsTechnical: deform, structuralFailure, warnings, document, bin: parsed.bin, parents });
}

function nodeRestTrs(node: JsonRecord): { translation: Vec3; rotation: Quat; scale: Vec3 } {
  if (Array.isArray(node.matrix) && node.matrix.length === 16 && node.matrix.every(finite)) return decompose(node.matrix as number[]);
  const translation = Array.isArray(node.translation) && node.translation.length === 3 ? node.translation as number[] : [0, 0, 0];
  const rotation = Array.isArray(node.rotation) && node.rotation.length === 4 ? node.rotation as number[] : [0, 0, 0, 1];
  const scale = Array.isArray(node.scale) && node.scale.length === 3 ? node.scale as number[] : [1, 1, 1];
  return { translation: [Number(translation[0]), Number(translation[1]), Number(translation[2])], rotation: normalizeQuat([Number(rotation[0]), Number(rotation[1]), Number(rotation[2]), Number(rotation[3])]), scale: [Number(scale[0]), Number(scale[1]), Number(scale[2])] };
}

function worldMatrices(nodes: JsonRecord[], parents: Record<number, number | null>, locals: Mat4[]): Mat4[] {
  const result: Array<Mat4 | undefined> = [];
  const resolve = (index: number, seen: Set<number>): Mat4 => {
    if (result[index]) return result[index]!;
    if (seen.has(index)) throw new Error(`node ${index} is part of a parent cycle`);
    const parent = parents[index];
    const world = parent === null || parent === undefined ? locals[index]! : multiply(resolve(parent, new Set([...seen, index])), locals[index]!);
    result[index] = world;
    return world;
  };
  return nodes.map((_, index) => resolve(index, new Set()));
}

export function restWorldMatrices(rig: GlbRig): Mat4[] {
  const nodes = nodeList(rig.document);
  return worldMatrices(nodes, rig.parents, nodes.map((node) => composeTrs(nodeRestTrs(node).translation, nodeRestTrs(node).rotation, nodeRestTrs(node).scale)));
}

export function jointRestPositions(rig: GlbRig): Record<number, Vec3> {
  const world = restWorldMatrices(rig);
  return Object.fromEntries(rig.joints.filter((joint) => world[joint.nodeIndex]).map((joint) => [joint.skinJointIndex, matrixTranslation(world[joint.nodeIndex]!)]));
}

export function deriveFigureHeight(rig: GlbRig): [number, string] {
  const lows: number[] = [], highs: number[] = [];
  if (Array.isArray(rig.document.meshes)) for (const mesh of rig.document.meshes) if (isRecord(mesh) && Array.isArray(mesh.primitives)) for (const primitive of mesh.primitives) if (isRecord(primitive) && isRecord(primitive.attributes) && typeof primitive.attributes.POSITION === "number") {
    try {
      const points = readAccessor(rig.document, rig.bin, primitive.attributes.POSITION);
      for (const point of points) if (finite(point[1])) { lows.push(point[1]!); highs.push(point[1]!); }
    } catch { /* malformed bounds are reported when no measurable height remains */ }
  }
  if (!lows.length) throw new Error("figure height could not be measured from the GLB mesh bounds; pass it explicitly");
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of lows) low = Math.min(low, value);
  for (const value of highs) high = Math.max(high, value);
  const height = high - low;
  if (!(height > 0)) throw new Error("figure height measured as zero from the GLB mesh bounds");
  return [height, "meshPositionBoundsYExtent"];
}

export interface BoneMatch {
  boneId: string;
  bonePosition: Vec3;
  skinJointIndex: number | null;
  nodeIndex: number | null;
  nodeName: string | null;
  distanceH: number | null;
  confidence: number;
  reason: string;
}

export interface Correspondence {
  figureHeight: number;
  tolerance: number;
  matches: BoneMatch[];
  unmatchedProceduralBones: string[];
  unmatchedGlbJoints: GlbJoint[];
  usable: boolean;
  reason: string;
}

export function correspondence(rig: GlbRig, componentBones: Array<{ id?: string; position?: number[]; jointPosition?: number[]; modelPosition?: number[]; head?: number[] }>, figureHeight?: number, tolerance = CORRESPONDENCE_TOLERANCE): Correspondence {
  const height = figureHeight ?? deriveFigureHeight(rig)[0];
  if (!Number.isFinite(height) || height <= 0) throw new Error("figureHeight must be a finite positive number");
  const positions = jointRestPositions(rig);
  const bones = componentBones.map((bone, index) => {
    const value = bone.position ?? bone.jointPosition ?? bone.modelPosition ?? bone.head;
    if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) throw new Error(`procedural bone ${bone.id ?? index} has no model-space joint position`);
    return { id: bone.id ?? `bone-${index}`, position: value as Vec3 };
  });
  const candidates: Array<[number, number, number]> = [];
  for (let boneIndex = 0; boneIndex < bones.length; boneIndex += 1) for (const joint of rig.joints) {
    const jointPosition = positions[joint.skinJointIndex];
    if (!jointPosition) continue;
    const d = Math.hypot(...bones[boneIndex]!.position.map((value, axis) => value - jointPosition[axis]!));
    if (d <= tolerance * height) candidates.push([d, boneIndex, joint.skinJointIndex]);
  }
  candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const claimedBones = new Set<number>(), claimedJoints = new Set<number>(), claims = new Map<number, [number, number]>();
  for (const [d, boneIndex, jointIndex] of candidates) if (!claimedBones.has(boneIndex) && !claimedJoints.has(jointIndex)) { claimedBones.add(boneIndex); claimedJoints.add(jointIndex); claims.set(boneIndex, [d, jointIndex]); }
  const matches: BoneMatch[] = [], unmatchedProceduralBones: string[] = [];
  for (let index = 0; index < bones.length; index += 1) {
    const bone = bones[index]!, claim = claims.get(index);
    if (!claim) { unmatchedProceduralBones.push(bone.id); matches.push({ boneId: bone.id, bonePosition: bone.position, skinJointIndex: null, nodeIndex: null, nodeName: null, distanceH: null, confidence: 0, reason: `no GLB joint within ${tolerance}H` }); continue; }
    const joint = rig.joints[claim[1]!]!, distanceH = claim[0] / height;
    matches.push({ boneId: bone.id, bonePosition: bone.position, skinJointIndex: joint.skinJointIndex, nodeIndex: joint.nodeIndex, nodeName: joint.nodeName, distanceH, confidence: Math.max(0, Math.min(1, 1 - distanceH / tolerance)), reason: `nearest GLB joint at ${distanceH.toFixed(4)}H, inside the ${tolerance}H tolerance` });
  }
  const unmatchedGlbJoints = rig.joints.filter((joint) => !claimedJoints.has(joint.skinJointIndex));
  const usable = unmatchedProceduralBones.length === 0 && unmatchedGlbJoints.length === 0;
  return { figureHeight: height, tolerance, matches, unmatchedProceduralBones, unmatchedGlbJoints, usable, reason: usable ? `every one of ${bones.length} procedural bones and all ${rig.joints.length} GLB joints matched within ${tolerance}H` : "partial correspondence is not usable for retargeting" };
}

interface Sampler { times: number[]; values: number[][]; interpolation: string }

function loadSamplers(rig: GlbRig, clip: GlbClip): Map<number, Sampler> {
  const animations = rig.document.animations;
  const animation = Array.isArray(animations) && isRecord(animations[clip.animationIndex]) ? animations[clip.animationIndex] as JsonRecord : {};
  const result = new Map<number, Sampler>();
  if (!Array.isArray(animation.samplers)) return result;
  animation.samplers.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.input !== "number" || typeof raw.output !== "number") return;
    const times = readAccessor(rig.document, rig.bin, raw.input).map((value) => value[0]!);
    result.set(index, { times, values: readAccessor(rig.document, rig.bin, raw.output), interpolation: typeof raw.interpolation === "string" ? raw.interpolation : "LINEAR" });
  });
  return result;
}

function bracket(times: number[], time: number): [number, number, number] {
  if (!times.length) throw new Error("sampler has no key times");
  if (time <= times[0]!) return [0, 0, 0];
  if (time >= times.at(-1)!) return [times.length - 1, times.length - 1, 0];
  let low = 0, high = times.length - 1;
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (times[middle]! <= time) low = middle; else high = middle; }
  const span = times[high]! - times[low]!;
  return [low, high, span <= 0 ? 0 : (time - times[low]!) / span];
}

function evaluateSampler(sampler: Sampler, path: string, time: number, clipName: string): number[] {
  if (!SUPPORTED_INTERPOLATIONS.includes(sampler.interpolation as typeof SUPPORTED_INTERPOLATIONS[number])) throw new UnsupportedInterpolation(clipName, sampler.interpolation, `path ${JSON.stringify(path)}`);
  const [low, high, alpha] = bracket(sampler.times, time);
  const a = sampler.values[low], b = sampler.values[high];
  if (!a || !b) throw new Error(`clip ${clipName}: sampler output has ${sampler.values.length} values for ${sampler.times.length} key times`);
  if (sampler.interpolation === "STEP" || low === high || alpha === 0) return [...a];
  if (path === "rotation") return slerp([a[0]!, a[1]!, a[2]!, a[3]!], [b[0]!, b[1]!, b[2]!, b[3]!], alpha);
  return a.map((value, index) => value + (b[index]! - value) * alpha);
}

function poseAt(rig: GlbRig, nodes: JsonRecord[], rest: Array<{ translation: Vec3; rotation: Quat; scale: Vec3 }>, channels: Array<[GlbChannel, Sampler]>, time: number, clipName: string): { world: Mat4[]; trs: Array<{ translation: Vec3; rotation: Quat; scale: Vec3 }> } {
  const trs = rest.map((item) => ({ translation: [...item.translation] as Vec3, rotation: [...item.rotation] as Quat, scale: [...item.scale] as Vec3 }));
  for (const [channel, sampler] of channels) {
    if (channel.targetNodeIndex === null || !TRS_PATHS.includes(channel.path as typeof TRS_PATHS[number])) continue;
    if (!trs[channel.targetNodeIndex]) continue;
    const value = evaluateSampler(sampler, channel.path, time, clipName);
    const current = trs[channel.targetNodeIndex]!;
    if (channel.path === "translation" && value.length >= 3) current.translation = [value[0]!, value[1]!, value[2]!];
    if (channel.path === "rotation" && value.length >= 4) current.rotation = normalizeQuat([value[0]!, value[1]!, value[2]!, value[3]!]);
    if (channel.path === "scale" && value.length >= 3) current.scale = [value[0]!, value[1]!, value[2]!];
  }
  return { world: worldMatrices(nodes, rig.parents, trs.map((item) => composeTrs(item.translation, item.rotation, item.scale))), trs };
}

export function sampleClips(rig: GlbRig, landmarkNodeIndices: Record<string, number>, sampleCount = DEFAULT_SAMPLE_COUNT, figureHeight?: number): JsonRecord {
  const missing = ["hip", "head", "hand.l", "hand.r", "foot.l", "foot.r"].filter((name) => landmarkNodeIndices[name] === undefined);
  if (missing.length) throw new Error(`landmark_node_indices is missing ${missing.join(", ")}`);
  if (sampleCount < 2) throw new Error(`sampleCount must be at least 2; got ${sampleCount}`);
  const [height, heightSource] = figureHeight === undefined ? deriveFigureHeight(rig) : [figureHeight, "caller"] as [number, string];
  if (!finite(height) || height <= 0) throw new Error("figureHeight must be a finite positive number");
  const nodes = nodeList(rig.document), rest = nodes.map(nodeRestTrs), jointNodeIndices = rig.joints.map((joint) => joint.nodeIndex);
  const clips: JsonRecord[] = [], skippedClips: JsonRecord[] = [];
  let morphWeightChannelsIgnored = 0;
  for (const clip of rig.clips) {
    if (!(clip.duration > 0)) { skippedClips.push({ sourceName: clip.name, reason: "clip duration is zero" }); continue; }
    const samplers = loadSamplers(rig, clip), bound: Array<[GlbChannel, Sampler]> = [];
    for (const channel of clip.channels) {
      const sampler = samplers.get(channel.samplerIndex);
      if (!sampler) continue;
      if (channel.path === "weights") { morphWeightChannelsIgnored += 1; continue; }
      if (!TRS_PATHS.includes(channel.path as typeof TRS_PATHS[number])) continue;
      if (!SUPPORTED_INTERPOLATIONS.includes(sampler.interpolation as typeof SUPPORTED_INTERPOLATIONS[number])) throw new UnsupportedInterpolation(clip.name, sampler.interpolation, `path ${JSON.stringify(channel.path)}`);
      bound.push([channel, sampler]);
    }
    const times = Array.from({ length: sampleCount }, (_, index) => clip.duration * index / (sampleCount - 1));
    const positions: Record<string, Vec3[]> = Object.fromEntries(Object.keys(landmarkNodeIndices).map((name) => [name, []])) as Record<string, Vec3[]>;
    const jointScaleDelta: number[] = [];
    let firstRotations: Quat[] | undefined, lastRotations: Quat[] | undefined;
    for (let sampleIndex = 0; sampleIndex < times.length; sampleIndex += 1) {
      const pose = poseAt(rig, nodes, rest, bound, times[sampleIndex]!, clip.name);
      for (const [name, index] of Object.entries(landmarkNodeIndices)) {
        if (!pose.world[index]) throw new Error(`landmark ${name} points at node ${index}, which does not exist`);
        positions[name]!.push(matrixTranslation(pose.world[index]!));
      }
      let delta = 0;
      for (const nodeIndex of jointNodeIndices) for (const axis of pose.trs[nodeIndex]?.scale ?? [1, 1, 1]) delta = Math.max(delta, Math.abs(axis - 1));
      jointScaleDelta.push(delta > SCALE_UNIT_EPSILON ? delta : 0);
      const rotations = jointNodeIndices.map((nodeIndex) => pose.trs[nodeIndex]?.rotation).filter((rotation): rotation is Quat => rotation !== undefined);
      if (sampleIndex === 0) firstRotations = rotations;
      lastRotations = rotations;
    }
    const poseReturn = firstRotations && lastRotations && firstRotations.length === lastRotations.length ? Math.max(0, ...firstRotations.map((rotation, index) => quaternionAngleDegrees(rotation, lastRotations![index]!))) : null;
    const clipPayload: JsonRecord = { sourceName: clip.name, duration: clip.duration, sampleTimes: times, landmarkPositions: positions, jointScaleDelta };
    if (poseReturn !== null) clipPayload.poseReturn = poseReturn;
    clips.push(clipPayload);
  }
  return { figureHeight: height, landmarks: Object.keys(landmarkNodeIndices), clips, provenance: { source: rig.path, sampledFrom: "the GLB's own animation channels, evaluated by glb-rig-reference", figureHeightSource: heightSource, sampleCount, landmarkNodeIndices, jointCount: jointNodeIndices.length, morphWeightChannelsIgnored, skippedClips, stance: "omitted: this host cannot measure foot contact" } };
}

export function resolveLandmarks(rig: GlbRig, landmarkNames: Record<string, string | number>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [landmark, requested] of Object.entries(landmarkNames)) {
    if (typeof requested === "number") { output[landmark] = requested; continue; }
    const matches = rig.nodes.map((node, index) => ({ index, name: node.name })).filter((candidate) => candidate.name === requested);
    if (matches.length !== 1) throw new Error(`landmark ${JSON.stringify(landmark)} name ${JSON.stringify(requested)} resolved to ${matches.length} nodes; exactly one is required`);
    output[landmark] = matches[0]!.index;
  }
  return output;
}

export const read_rig = readRig;
export const sample_clips = sampleClips;
export const joint_rest_positions = jointRestPositions;
export const derive_figure_height = deriveFigureHeight;
