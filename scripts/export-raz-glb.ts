import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type JsonRecord = Record<string, unknown>;

interface SurfacePart {
  id: string;
  vertexCount: number;
  triangleCount: number;
  bytes: { positions: number; normals: number; colours: number; indices: number };
}

interface SurfaceModel {
  version: number;
  quantization: { origin: Vec3; extent: Vec3 };
  height: number;
  parts: SurfacePart[];
}

interface DecodedPart {
  meta: SurfacePart;
  position: Float32Array;
  normal: Float32Array;
  colour: Float32Array;
  index: Uint32Array;
}

interface Bone {
  name: string;
  parent: number;
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  inverseBind: number[];
}

interface ClipTrack {
  bone: number;
  times: string;
  position?: string;
  quaternion?: string;
  scale?: string;
}

interface Clip {
  name: string;
  duration: number;
  tracks: ClipTrack[];
}

interface Rig {
  bones: Bone[];
  clips: Clip[];
  skinIndex: string;
  skinWeight: string;
  normalise: { scale: number; offset: Vec3 };
  vertexCount: number;
}

interface ParsedShowcase {
  model: SurfaceModel;
  stream: string;
  rig: Rig;
  sourceFiles: { surface: string; rig: string };
}

function balancedObject(source: string, marker: string): JsonRecord {
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) throw new Error(`showcase source is missing ${marker}`);
  const start = source.indexOf("{", markerAt);
  if (start < 0) throw new Error(`${marker} has no JSON object`);
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, index + 1)) as JsonRecord;
    }
  }
  throw new Error(`${marker} JSON object is unterminated`);
}

function stringExpression(source: string, marker: string): string {
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) throw new Error(`showcase source is missing ${marker}`);
  const equals = source.indexOf("=", markerAt);
  const semicolon = source.indexOf(";", equals);
  if (equals < 0 || semicolon < 0) throw new Error(`${marker} string expression is unterminated`);
  const expression = source.slice(equals + 1, semicolon);
  const strings = [...expression.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");
  if (!strings.length) throw new Error(`${marker} contains no string literals`);
  return strings.join("");
}

function loadShowcase(showcaseRoot: string): ParsedShowcase {
  const surfacePath = path.join(showcaseRoot, "src/demos/raz/surfaceData.high.ts");
  const rigPath = path.join(showcaseRoot, "src/demos/raz/rigData.ts");
  const surfaceSource = readFileSync(surfacePath, "utf8");
  const rigSource = readFileSync(rigPath, "utf8");
  return {
    model: balancedObject(surfaceSource, "export const SURFACE_MODEL") as unknown as SurfaceModel,
    stream: stringExpression(surfaceSource, "export const SURFACE_STREAM"),
    rig: balancedObject(rigSource, "export const RIG") as unknown as Rig,
    sourceFiles: { surface: surfacePath, rig: rigPath }
  };
}

function decodeBase64(text: string): Buffer {
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length) throw new Error("showcase base64 payload decoded to zero bytes");
  return bytes;
}

function decodeFloats(text: string): Float32Array {
  const bytes = decodeBase64(text);
  if (bytes.length % 4 !== 0) throw new Error(`float payload has ${bytes.length} bytes, not a multiple of 4`);
  const result = new Float32Array(bytes.length / 4);
  for (let index = 0; index < result.length; index += 1) result[index] = bytes.readFloatLE(index * 4);
  return result;
}

function decodeUint16s(text: string): Uint16Array {
  const bytes = decodeBase64(text);
  if (bytes.length % 2 !== 0) throw new Error(`uint16 payload has ${bytes.length} bytes, not a multiple of 2`);
  const result = new Uint16Array(bytes.length / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = bytes.readUInt16LE(index * 2);
  return result;
}

function decodeOctNormal(packed: number, result: Float32Array, at: number): void {
  let x = ((packed & 0xff) / 255) * 2 - 1;
  let y = ((packed >> 8) / 255) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1);
    y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1);
  }
  const length = Math.hypot(x, y, z) || 1;
  result[at] = x / length;
  result[at + 1] = y / length;
  result[at + 2] = z / length;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function decodeSurface(model: SurfaceModel, encoded: string): DecodedPart[] {
  if (model.version !== 1) throw new Error(`unsupported showcase surface version ${model.version}`);
  const stream = decodeBase64(encoded);
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let multiplier = 1;
    for (;;) {
      if (at >= stream.length) throw new Error("showcase surface stream is truncated in an index varint");
      const byte = stream[at++]!;
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
  };
  const decoded: DecodedPart[] = [];
  for (const meta of model.parts) {
    const vertices = meta.vertexCount;
    const triangles = meta.triangleCount;
    if (meta.bytes.positions !== vertices * 6 || meta.bytes.normals !== vertices * 2 || meta.bytes.colours !== vertices * 3) {
      throw new Error(`part ${meta.id} section sizes disagree with its vertex count`);
    }
    const position = new Float32Array(vertices * 3);
    for (let index = 0; index < position.length; index += 1) {
      if (at + 2 > stream.length) throw new Error(`part ${meta.id} position section is truncated`);
      const quantized = stream.readUInt16LE(at);
      at += 2;
      const axis = index % 3;
      position[index] = model.quantization.origin[axis] + (quantized / 65535) * model.quantization.extent[axis];
    }
    const normal = new Float32Array(vertices * 3);
    for (let index = 0; index < vertices; index += 1) {
      if (at + 2 > stream.length) throw new Error(`part ${meta.id} normal section is truncated`);
      decodeOctNormal(stream.readUInt16LE(at), normal, index * 3);
      at += 2;
    }
    const colour = new Float32Array(vertices * 3);
    for (let index = 0; index < colour.length; index += 1) {
      if (at >= stream.length) throw new Error(`part ${meta.id} colour section is truncated`);
      colour[index] = srgbToLinear(stream[at++]! / 255);
    }
    const indexStart = at;
    const indices = new Uint32Array(triangles * 3);
    let previous = 0;
    for (let index = 0; index < indices.length; index += 1) {
      const raw = readVarint();
      previous += raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
      if (previous < 0 || previous >= vertices) throw new Error(`part ${meta.id} index ${previous} is out of range`);
      indices[index] = previous;
    }
    if (at - indexStart !== meta.bytes.indices) throw new Error(`part ${meta.id} index byte count does not match its metadata`);
    decoded.push({ meta, position, normal, colour, index: indices });
  }
  if (at !== stream.length) throw new Error(`showcase surface stream consumed ${at} of ${stream.length} bytes`);
  return decoded;
}

function matrixFromTrs(translation: Vec3, rotation: Quat, scale: Vec3): number[] {
  const [x, y, z, w] = rotation;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const [sx, sy, sz] = scale;
  return [
    (1 - (yy + zz)) * sx,
    (xy - wz) * sy,
    (xz + wy) * sz,
    translation[0],
    (xy + wz) * sx,
    (1 - (xx + zz)) * sy,
    (yz - wx) * sz,
    translation[1],
    (xz - wy) * sx,
    (yz + wx) * sy,
    (1 - (xx + yy)) * sz,
    translation[2],
    0,
    0,
    0,
    1
  ];
}

function addWorldPosition(bones: Bone[], index: number, cache: Array<Vec3 | undefined>): Vec3 {
  const cached = cache[index];
  if (cached) return cached;
  const bone = bones[index];
  if (!bone) throw new Error(`bone ${index} is missing`);
  const local = bone.position;
  const world = bone.parent < 0 ? [...local] as Vec3 : addWorldPosition(bones, bone.parent, cache).map((value, axis) => value + local[axis]) as Vec3;
  cache[index] = world;
  return world;
}

function normalizeRoot(root: string): string {
  const absolute = path.resolve(root);
  if (!absolute) throw new Error("showcase root is empty");
  return absolute;
}

function getArgument(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requireArgument(name: string): string {
  const value = getArgument(name);
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

function hasArgument(name: string): boolean {
  return process.argv.includes(name);
}

type ComponentType = 5121 | 5123 | 5125 | 5126;

interface BufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
}

interface Accessor {
  bufferView: number;
  componentType: ComponentType;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

class BinaryBuilder {
  readonly chunks: Buffer[] = [];
  readonly views: BufferView[] = [];
  readonly accessors: Accessor[] = [];
  byteLength = 0;

  private align(): void {
    const padding = (4 - (this.byteLength % 4)) % 4;
    if (padding) {
      this.chunks.push(Buffer.alloc(padding));
      this.byteLength += padding;
    }
  }

  private append(bytes: Buffer, target?: number): number {
    this.align();
    const byteOffset = this.byteLength;
    this.chunks.push(bytes);
    this.byteLength += bytes.length;
    const view: BufferView = { buffer: 0, byteOffset, byteLength: bytes.length };
    if (target !== undefined) view.target = target;
    this.views.push(view);
    return this.views.length - 1;
  }

  accessor(values: number[], components: number, componentType: ComponentType, target?: number): number {
    const bytesPerComponent = componentType === 5126 || componentType === 5125 ? 4 : componentType === 5123 ? 2 : 1;
    const bytes = Buffer.alloc(values.length * bytesPerComponent);
    values.forEach((value, index) => {
      const offset = index * bytesPerComponent;
      if (componentType === 5126) bytes.writeFloatLE(value, offset);
      else if (componentType === 5125) bytes.writeUInt32LE(value, offset);
      else if (componentType === 5123) bytes.writeUInt16LE(value, offset);
      else bytes.writeUInt8(value, offset);
    });
    const bufferView = this.append(bytes, target);
    const type = components === 1 ? "SCALAR" : components === 16 ? "MAT4" : `VEC${components}`;
    const count = values.length / components;
    if (!Number.isInteger(count)) throw new Error(`accessor values are not divisible into ${components} components`);
    const accessor: Accessor = { bufferView, componentType, count, type };
    if (componentType === 5126 || componentType === 5125) {
      const min = Array.from({ length: components }, () => Number.POSITIVE_INFINITY);
      const max = Array.from({ length: components }, () => Number.NEGATIVE_INFINITY);
      for (let index = 0; index < values.length; index += 1) {
        const component = index % components;
        min[component] = Math.min(min[component]!, values[index]!);
        max[component] = Math.max(max[component]!, values[index]!);
      }
      accessor.min = min;
      accessor.max = max;
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  bytes(): Buffer {
    this.align();
    return Buffer.concat(this.chunks, this.byteLength);
  }
}

function outputPaths(glbPath: string): { glb: string; mesh: string; report: string } {
  const root = glbPath.replace(/\.glb$/i, "");
  return { glb: glbPath, mesh: `${root}.mesh.json`, report: `${root}.export.json` };
}

function makeGlb(parsed: ParsedShowcase, parts: DecodedPart[], clips: Clip[]): { glb: Buffer; meshPayload: JsonRecord; report: JsonRecord } {
  if (parts.length !== 1) throw new Error(`Raz export requires one merged mesh, found ${parts.length}`);
  const part = parts[0]!;
  if (parsed.rig.vertexCount !== part.meta.vertexCount) throw new Error("showcase rig and surface vertex counts differ");
  const skinIndex = decodeUint16s(parsed.rig.skinIndex);
  const skinWeight = decodeFloats(parsed.rig.skinWeight);
  if (skinIndex.length !== parsed.rig.vertexCount * 4 || skinWeight.length !== parsed.rig.vertexCount * 4) throw new Error("showcase skin payload does not have four values per vertex");
  if (parsed.rig.bones.length !== 41) throw new Error(`Raz export expected 41 bones, found ${parsed.rig.bones.length}`);

  const binary = new BinaryBuilder();
  const positionAccessor = binary.accessor(Array.from(part.position), 3, 5126, 34962);
  const normalAccessor = binary.accessor(Array.from(part.normal), 3, 5126, 34962);
  const colourAccessor = binary.accessor(Array.from(part.colour), 3, 5126, 34962);
  const skinIndexAccessor = binary.accessor(Array.from(skinIndex), 4, 5123, 34962);
  const skinWeightAccessor = binary.accessor(Array.from(skinWeight), 4, 5126, 34962);
  const indexAccessor = binary.accessor(Array.from(part.index), 1, 5125, 34963);
  const inverseBindAccessor = binary.accessor(parsed.rig.bones.flatMap((bone) => bone.inverseBind), 16, 5126);

  const nodes: JsonRecord[] = [];
  const sceneRoot = nodes.push({
    name: "Raz",
    children: [1, 2],
    translation: parsed.rig.normalise.offset,
    scale: [parsed.rig.normalise.scale, parsed.rig.normalise.scale, parsed.rig.normalise.scale]
  }) - 1;
  if (sceneRoot !== 0) throw new Error("internal GLB node ordering error");
  nodes.push({ name: part.meta.id, mesh: 0, skin: 0 });
  parsed.rig.bones.forEach((bone, index) => {
    const node: JsonRecord = {
      name: bone.name,
      translation: bone.position,
      rotation: bone.quaternion,
      scale: bone.scale
    };
    nodes.push(node);
    if (bone.parent >= 0) {
      const parent = nodes[2 + bone.parent]!;
      const children = Array.isArray(parent.children) ? parent.children as number[] : [];
      children.push(2 + index);
      parent.children = children;
    }
  });

  const animations: JsonRecord[] = [];
  for (const clip of clips) {
    const samplers: JsonRecord[] = [];
    const channels: JsonRecord[] = [];
    for (const track of clip.tracks) {
      const targetNode = 2 + track.bone;
      const properties: Array<[string, string | undefined, number]> = [
        ["translation", track.position, 3],
        ["rotation", track.quaternion, 4],
        ["scale", track.scale, 3]
      ];
      for (const [pathName, encoded, components] of properties) {
        if (!encoded) continue;
        const times = Array.from(decodeFloats(track.times));
        const values = Array.from(decodeFloats(encoded));
        const input = binary.accessor(times, 1, 5126);
        const output = binary.accessor(values, components, 5126);
        const sampler = samplers.push({ input, output, interpolation: "LINEAR" }) - 1;
        channels.push({ sampler, target: { node: targetNode, path: pathName } });
      }
    }
    animations.push({ name: clip.name, samplers, channels });
  }

  const document: JsonRecord = {
    asset: { version: "2.0", generator: "PRD-346 Raz exporter from img2threejs showcase commit ca7a8ac2a9c1207ac01b0316cece12b7cace4d28" },
    scene: 0,
    scenes: [{ name: "Raz", nodes: [0] }],
    nodes,
    meshes: [{ name: part.meta.id, primitives: [{ attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, COLOR_0: colourAccessor, JOINTS_0: skinIndexAccessor, WEIGHTS_0: skinWeightAccessor }, indices: indexAccessor, material: 0, mode: 4 }] }],
    materials: [{ name: "raz-measured-surface", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: part.meta.material?.metalness ?? 0.7725, roughnessFactor: part.meta.material?.roughness ?? 0.0392 }, alphaMode: "OPAQUE", doubleSided: false }],
    skins: [{ name: "RazArmature", skeleton: 2, joints: parsed.rig.bones.map((_, index) => 2 + index), inverseBindMatrices: inverseBindAccessor }],
    animations,
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: binary.views,
    accessors: binary.accessors
  };
  const json = Buffer.from(JSON.stringify(document));
  const jsonPadding = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const bin = binary.bytes();
  const binPadding = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPadding)]);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  const worldPositions: Array<Vec3 | undefined> = [];
  const rigPayload: JsonRecord = {
    schemaVersion: 1,
    coordinateSystem: { up: "Y", handedness: "right", unit: "metres" },
    joints: parsed.rig.bones.map((_, index) => addWorldPosition(parsed.rig.bones, index, worldPositions)),
    parents: parsed.rig.bones.map((bone) => bone.parent < 0 ? null : bone.parent),
    names: parsed.rig.bones.map((bone) => bone.name),
    matrix_local: parsed.rig.bones.map((bone) => matrixFromTrs(bone.position, bone.quaternion, bone.scale)),
    skinIndex: Array.from({ length: parsed.rig.vertexCount }, (_, vertex) => Array.from(skinIndex.slice(vertex * 4, vertex * 4 + 4))),
    skinWeight: Array.from({ length: parsed.rig.vertexCount }, (_, vertex) => Array.from(skinWeight.slice(vertex * 4, vertex * 4 + 4)))
  };
  const meshPayload: JsonRecord = {
    schemaVersion: 1,
    figureHeight: parsed.model.height,
    meshes: [{ name: part.meta.id, attributes: { position: Array.from(part.position), normal: Array.from(part.normal), skinIndex: Array.from(skinIndex), skinWeight: Array.from(skinWeight) }, index: Array.from(part.index) }],
    rigPayload,
    chainNodes: parsed.rig.bones.map((bone, index) => ({
      id: bone.name,
      parent: bone.parent < 0 ? null : parsed.rig.bones[bone.parent]?.name ?? null,
      localPosition: bone.position,
      skinJointIndex: index
    }))
  };
  const report: JsonRecord = {
    schemaVersion: 1,
    sourceRevision: "ca7a8ac2a9c1207ac01b0316cece12b7cace4d28",
    sourceFiles: parsed.sourceFiles,
    meshCount: 1,
    vertexCount: part.meta.vertexCount,
    triangleCount: part.meta.triangleCount,
    boneCount: parsed.rig.bones.length,
    actionCount: clips.length,
    clipNames: clips.map((clip) => clip.name),
    glbCoordinateSystem: { up: "Y", handedness: "right", unit: "metres" },
    note: "The GLB is decoded from the showcase's embedded measured surface, skin buffers and animation channels; no synthetic mesh or animation is substituted."
  };
  return { glb: Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]), meshPayload, report };
}

export function exportRazGlb(showcaseRoot: string, glbPath: string, dropClip?: string): JsonRecord {
  const parsed = loadShowcase(normalizeRoot(showcaseRoot));
  const parts = decodeSurface(parsed.model, parsed.stream);
  const clips = parsed.rig.clips.filter((clip) => clip.name !== dropClip);
  if (dropClip && clips.length === parsed.rig.clips.length) throw new Error(`cannot drop unknown clip ${dropClip}`);
  const built = makeGlb(parsed, parts, clips);
  const paths = outputPaths(glbPath);
  mkdirSync(path.dirname(paths.glb), { recursive: true });
  writeFileSync(paths.glb, built.glb);
  writeFileSync(paths.mesh, JSON.stringify({ ...built.meshPayload, exportReport: built.report }));
  writeFileSync(paths.report, JSON.stringify(built.report, null, 2) + "\n");
  return { ...built.report, output: paths };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const showcase = requireArgument("--showcase");
    const out = requireArgument("--out");
    const dropClip = getArgument("--drop-clip");
    if (hasArgument("--help")) {
      process.stdout.write("Usage: pnpm tsx scripts/export-raz-glb.ts --showcase <showcase checkout> --out <raz.glb> [--drop-clip <name>]\n");
    } else {
      process.stdout.write(`${JSON.stringify(exportRazGlb(showcase, out, dropClip), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
