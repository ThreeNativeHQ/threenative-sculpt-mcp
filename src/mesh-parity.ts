import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const SCHEMA_VERSION = 1;
export const FROZEN_ATTRIBUTES = ["position", "normal", "uv"] as const;
export const INDEX_KEY = "index";
export const FROZEN_BUFFERS = [...FROZEN_ATTRIBUTES, INDEX_KEY] as const;
export const ELEMENT_BYTES = 8;
export const STATUS_PASS = "pass";
export const STATUS_FAIL = "fail";
export const STATUS_UNEVALUATED = "unevaluated";

export const KIND_HASH = "hash mismatch";
export const KIND_MESH_MISSING = "mesh missing";
export const KIND_MESH_ADDED = "mesh added";
export const KIND_COUNT = "count changed";
export const KIND_ATTRIBUTE_MISSING = "attribute missing";
export const KIND_ATTRIBUTE_ADDED = "frozen attribute added";
export const KIND_DUPLICATE = "duplicate mesh name";
export const KIND_MALFORMED = "malformed buffer";

const FREEZE_NOTE =
  "Geometry frozen. Implementation may add a skeleton, skinIndex/skinWeight and clips; it may not change position, normal, uv or index on any mesh, and it may not add or remove meshes.";
const NO_MANIFEST_REASON =
  "no freeze manifest was supplied, so there is nothing to compare the payload against; geometry parity is unproven, which is not the same as unbroken";
const EMPTY_MANIFEST_REASON =
  "the freeze manifest records no meshes, so no geometry was ever frozen; geometry parity is unproven, which is not the same as unbroken";
const ORDER = new Map<string, number>(FROZEN_BUFFERS.map((name, index) => [name, index]));

type NumericBuffer = number[];
type JsonRecord = Record<string, unknown>;

interface PayloadMesh {
  name: string;
  buffers: Record<string, NumericBuffer>;
  extraAttributes: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFloats(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of numbers`);
  return value.map((item, index) => {
    if (typeof item !== "number" || !Number.isFinite(item)) throw new Error(`${label}[${index}] must be a finite number`);
    return item;
  });
}

function asInts(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of integers`);
  return value.map((item, index) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item)) throw new Error(`${label}[${index}] must be a safe integer`);
    return item;
  });
}

function packed(name: string, values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * ELEMENT_BYTES);
  values.forEach((value, index) => {
    if (name === INDEX_KEY) buffer.writeBigInt64LE(BigInt(value), index * ELEMENT_BYTES);
    else buffer.writeDoubleLE(value, index * ELEMENT_BYTES);
  });
  return buffer;
}

export function hashBuffer(name: string, values: number[]): string {
  const tag = name === INDEX_KEY ? "i64le" : "f64le";
  return createHash("sha256")
    .update(`${name}|${values.length}|${tag}|`, "utf8")
    .update(packed(name, values))
    .digest("hex");
}

function readMeshes(payload: unknown): PayloadMesh[] {
  if (!isRecord(payload)) throw new Error("payload root must be an object");
  const raw = payload.meshes;
  if (!Array.isArray(raw)) throw new Error("payload must carry a meshes array");
  return raw.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`meshes[${index}] must be an object`);
    const name = entry.name;
    if (typeof name !== "string" || !name.trim()) throw new Error(`meshes[${index}].name must be a non-empty string`);
    const attributes = entry.attributes === undefined ? {} : entry.attributes;
    if (!isRecord(attributes)) throw new Error(`mesh ${name}: attributes must be an object`);
    if (INDEX_KEY in attributes) throw new Error(`mesh ${name}: index must sit beside attributes`);
    const buffers: Record<string, number[]> = {};
    const extraAttributes: string[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      if ((FROZEN_BUFFERS as readonly string[]).includes(key)) buffers[key] = key === INDEX_KEY ? asInts(value, `mesh ${name} attribute ${key}`) : asFloats(value, `mesh ${name} attribute ${key}`);
      else {
        if (!Array.isArray(value)) throw new Error(`mesh ${name} attribute ${key} must be a list`);
        extraAttributes.push(key);
      }
    }
    if (entry[INDEX_KEY] !== undefined && entry[INDEX_KEY] !== null) buffers[INDEX_KEY] = asInts(entry[INDEX_KEY], `mesh ${name} index`);
    return { name, buffers, extraAttributes: extraAttributes.sort() };
  });
}

function duplicates(names: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  names.forEach((name) => counts.set(name, (counts.get(name) ?? 0) + 1));
  return [...counts.entries()].filter(([, count]) => count > 1).sort(([a], [b]) => a.localeCompare(b));
}

export async function loadPayload(path: string): Promise<JsonRecord> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error("payload root must be an object");
  return value;
}

export interface MeshFingerprintInput {
  name: string;
  vertexCount: number;
  indexCount: number;
  attributes: string[];
  hashes: Record<string, string>;
  buffers: Record<string, number[]>;
}

export class MeshFingerprint {
  readonly name: string;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly attributes: string[];
  readonly hashes: Record<string, string>;
  readonly buffers: Record<string, number[]>;

  constructor(input: MeshFingerprintInput) {
    this.name = input.name;
    this.vertexCount = input.vertexCount;
    this.indexCount = input.indexCount;
    this.attributes = [...input.attributes];
    this.hashes = { ...input.hashes };
    this.buffers = Object.fromEntries(Object.entries(input.buffers).map(([key, value]) => [key, [...value]]));
  }

  toJSON(): MeshFingerprintInput {
    return {
      name: this.name,
      vertexCount: this.vertexCount,
      indexCount: this.indexCount,
      attributes: [...this.attributes],
      hashes: { ...this.hashes },
      buffers: Object.fromEntries(Object.entries(this.buffers).map(([key, value]) => [key, [...value]]))
    };
  }

  static fromJSON(value: unknown): MeshFingerprint {
    if (!isRecord(value)) throw new Error("manifest mesh must be an object");
    if (typeof value.name !== "string" || !Array.isArray(value.attributes) || !isRecord(value.hashes)) {
      throw new Error("manifest mesh must carry name, attributes and hashes");
    }
    const attributes = value.attributes.map((name) => {
      if (typeof name !== "string" || !ORDER.has(name)) throw new Error(`manifest has unknown frozen attribute ${String(name)}`);
      return name;
    });
    const hashes: Record<string, string> = {};
    const buffers: Record<string, number[]> = {};
    const retained = isRecord(value.buffers) ? value.buffers : {};
    for (const name of attributes) {
      const hash = value.hashes[name];
      if (typeof hash !== "string") throw new Error(`manifest mesh ${value.name} is missing hash for ${name}`);
      hashes[name] = hash;
      if (retained[name] !== undefined) buffers[name] = name === INDEX_KEY ? asInts(retained[name], `manifest mesh ${value.name} buffer ${name}`) : asFloats(retained[name], `manifest mesh ${value.name} buffer ${name}`);
    }
    return new MeshFingerprint({
      name: value.name,
      vertexCount: typeof value.vertexCount === "number" ? value.vertexCount : -1,
      indexCount: typeof value.indexCount === "number" ? value.indexCount : -1,
      attributes,
      hashes,
      buffers
    });
  }
}

export class Manifest {
  readonly schemaVersion: number;
  readonly frozenAttributes: string[];
  readonly meshes: MeshFingerprint[];

  constructor(schemaVersion: number, frozenAttributes: string[], meshes: MeshFingerprint[]) {
    this.schemaVersion = schemaVersion;
    this.frozenAttributes = [...frozenAttributes];
    this.meshes = [...meshes];
  }

  mesh(name: string): MeshFingerprint | undefined {
    return this.meshes.find((fingerprint) => fingerprint.name === name);
  }

  toSummaryJSON(): JsonRecord {
    return {
      schemaVersion: this.schemaVersion,
      kind: "mesh-freeze-summary",
      frozenAttributes: [...this.frozenAttributes],
      meshes: this.meshes.map((mesh) => ({ name: mesh.name, vertexCount: mesh.vertexCount, indexCount: mesh.indexCount, attributes: [...mesh.attributes], hashes: { ...mesh.hashes } })),
      note: FREEZE_NOTE
    };
  }

  toJSON(): JsonRecord {
    return {
      schemaVersion: this.schemaVersion,
      kind: "mesh-freeze-manifest",
      frozenAttributes: [...this.frozenAttributes],
      meshes: this.meshes.map((mesh) => mesh.toJSON()),
      note: FREEZE_NOTE
    };
  }

  static fromJSON(value: unknown): Manifest {
    if (!isRecord(value) || !Array.isArray(value.meshes)) throw new Error("manifest must carry a meshes array");
    return new Manifest(
      typeof value.schemaVersion === "number" ? value.schemaVersion : -1,
      Array.isArray(value.frozenAttributes) ? value.frozenAttributes.filter((item): item is string => typeof item === "string") : [],
      value.meshes.map((mesh) => MeshFingerprint.fromJSON(mesh))
    );
  }
}

export function freeze(payload: unknown): Manifest {
  const meshes = readMeshes(payload);
  const repeated = duplicates(meshes.map((mesh) => mesh.name));
  if (repeated.length) throw new Error(`cannot freeze: duplicate mesh names (${repeated.map(([name, count]) => `${name} x${count}`).join(", ")})`);
  const fingerprints = meshes.map((mesh) => {
    const position = mesh.buffers.position;
    if (!position) throw new Error(`cannot freeze mesh ${mesh.name}: it has no position attribute`);
    if (position.length % 3 !== 0) throw new Error(`cannot freeze mesh ${mesh.name}: position holds ${position.length} floats, not whole xyz vertices`);
    const buffers = Object.fromEntries(FROZEN_BUFFERS.filter((name) => mesh.buffers[name] !== undefined).map((name) => [name, [...mesh.buffers[name]!]]));
    return new MeshFingerprint({
      name: mesh.name,
      vertexCount: position.length / 3,
      indexCount: mesh.buffers[INDEX_KEY]?.length ?? 0,
      attributes: FROZEN_BUFFERS.filter((name) => buffers[name] !== undefined),
      hashes: Object.fromEntries(Object.entries(buffers).map(([name, values]) => [name, hashBuffer(name, values)])),
      buffers
    });
  });
  return new Manifest(SCHEMA_VERSION, [...FROZEN_BUFFERS], fingerprints);
}

export interface ElementDifferenceValue {
  index: number;
  frozen: number;
  current: number;
}

export class ElementDifference implements ElementDifferenceValue {
  readonly index: number;
  readonly frozen: number;
  readonly current: number;

  constructor(index: number, frozen: number, current: number) {
    this.index = index;
    this.frozen = frozen;
    this.current = current;
  }

  toJSON(): ElementDifferenceValue {
    return { index: this.index, frozen: this.frozen, current: this.current };
  }
}

export interface ParityFailureValue {
  mesh: string;
  attribute: string | null;
  kind: string;
  detail: string;
  differingElements: number;
  differences: ElementDifferenceValue[];
}

export class ParityFailure implements ParityFailureValue {
  readonly mesh: string;
  readonly attribute: string | null;
  readonly kind: string;
  readonly detail: string;
  readonly differingElements: number;
  readonly differences: ElementDifferenceValue[];

  constructor(input: ParityFailureValue) {
    this.mesh = input.mesh;
    this.attribute = input.attribute;
    this.kind = input.kind;
    this.detail = input.detail;
    this.differingElements = input.differingElements;
    this.differences = input.differences.map((difference) => ({ ...difference }));
  }

  toString(): string {
    return `${this.mesh}${this.attribute ? `.${this.attribute}` : ""}: ${this.kind} -- ${this.detail}`;
  }

  toJSON(): ParityFailureValue {
    return { mesh: this.mesh, attribute: this.attribute, kind: this.kind, detail: this.detail, differingElements: this.differingElements, differences: this.differences.map((difference) => ({ ...difference })) };
  }
}

export class ParityReport {
  readonly status: string;
  readonly meshesFrozen: number;
  readonly meshesCompared: number;
  readonly failureCount: number;
  readonly failures: ParityFailure[];
  readonly additionCount: number;
  readonly additions: string[];
  readonly reason: string | undefined;

  constructor(input: { status: string; meshesFrozen: number; meshesCompared: number; failureCount: number; failures: ParityFailure[]; additionCount: number; additions: string[]; reason?: string }) {
    this.status = input.status;
    this.meshesFrozen = input.meshesFrozen;
    this.meshesCompared = input.meshesCompared;
    this.failureCount = input.failureCount;
    this.failures = [...input.failures];
    this.additionCount = input.additionCount;
    this.additions = [...input.additions];
    this.reason = input.reason;
  }

  get ok(): boolean {
    return this.status === STATUS_PASS;
  }

  summary(): string {
    const lines = [
      `mesh parity: ${this.status.toUpperCase()} (schema ${SCHEMA_VERSION}, frozen: ${FROZEN_BUFFERS.join(", ")})`,
      `  meshes frozen ${this.meshesFrozen} compared ${this.meshesCompared} failures ${this.failureCount} added (legal) ${this.additionCount}`
    ];
    if (this.reason) lines.push(`  reason: ${this.reason}`);
    for (const failure of this.failures) lines.push(`  ${failure.toString()}`);
    if (this.additions.length) lines.push(`  added (legal): ${this.additions.join(", ")}`);
    return lines.join("\n");
  }

  toJSON(): JsonRecord {
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: "mesh-parity-report",
      status: this.status,
      ok: this.ok,
      reason: this.reason ?? null,
      frozenAttributes: [...FROZEN_BUFFERS],
      meshesFrozen: this.meshesFrozen,
      meshesCompared: this.meshesCompared,
      failureCount: this.failureCount,
      failures: this.failures.map((failure) => failure.toJSON()),
      addedLegalCount: this.additionCount,
      addedLegal: [...this.additions],
      summary: this.summary()
    };
  }
}

function firstDifferences(name: string, frozen: number[], current: number[]): { count: number; values: ElementDifferenceValue[] } {
  const left = packed(name, frozen);
  const right = packed(name, current);
  let count = 0;
  const values: ElementDifferenceValue[] = [];
  for (let index = 0; index < frozen.length; index += 1) {
    const start = index * ELEMENT_BYTES;
    if (!left.subarray(start, start + ELEMENT_BYTES).equals(right.subarray(start, start + ELEMENT_BYTES))) {
      count += 1;
      if (values.length < 8) values.push({ index, frozen: frozen[index]!, current: current[index]! });
    }
  }
  return { count, values };
}

function compareMesh(fingerprint: MeshFingerprint, mesh: PayloadMesh): { failures: ParityFailure[]; additions: string[] } {
  const failures: ParityFailure[] = [];
  const additions: string[] = [];
  const frozenNames = new Set(Object.keys(fingerprint.hashes));
  const present = new Set(Object.keys(mesh.buffers));
  for (const name of [...frozenNames].filter((key) => !present.has(key)).sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0))) {
    const retained = fingerprint.buffers[name];
    const expectedLength = retained?.length ?? (name === "position" ? fingerprint.vertexCount * 3 : name === INDEX_KEY ? fingerprint.indexCount : "an unrecorded number of");
    failures.push(new ParityFailure({ mesh: mesh.name, attribute: name, kind: KIND_ATTRIBUTE_MISSING, detail: `${name} was frozen with ${expectedLength} values and is absent from the payload`, differingElements: 0, differences: [] }));
  }
  for (const name of [...present].filter((key) => !frozenNames.has(key)).sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0))) {
    failures.push(new ParityFailure({ mesh: mesh.name, attribute: name, kind: KIND_ATTRIBUTE_ADDED, detail: `${name} is a frozen-class buffer that did not exist at freeze time`, differingElements: 0, differences: [] }));
  }
  additions.push(...mesh.extraAttributes.map((attribute) => `${mesh.name}.${attribute}`));
  const common = [...frozenNames].filter((name) => present.has(name));
  const counted = new Set<string>();
  if (common.includes("position")) {
    const position = mesh.buffers.position!;
    if (position.length % 3 !== 0) {
      failures.push(new ParityFailure({ mesh: mesh.name, attribute: "position", kind: KIND_MALFORMED, detail: `position holds ${position.length} floats, not whole xyz vertices`, differingElements: 0, differences: [] }));
      counted.add("position");
    } else if (position.length / 3 !== fingerprint.vertexCount) {
      failures.push(new ParityFailure({ mesh: mesh.name, attribute: null, kind: KIND_COUNT, detail: `vertexCount ${fingerprint.vertexCount} -> ${position.length / 3}`, differingElements: 0, differences: [] }));
      counted.add("position");
    }
  }
  if (common.includes(INDEX_KEY) && mesh.buffers[INDEX_KEY]!.length !== fingerprint.indexCount) {
    failures.push(new ParityFailure({ mesh: mesh.name, attribute: INDEX_KEY, kind: KIND_COUNT, detail: `indexCount ${fingerprint.indexCount} -> ${mesh.buffers[INDEX_KEY]!.length}`, differingElements: 0, differences: [] }));
    counted.add(INDEX_KEY);
  }
  for (const name of common.sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0))) {
    const frozen = fingerprint.buffers[name];
    const current = mesh.buffers[name]!;
    const expectedLength = frozen?.length || (name === "position" ? fingerprint.vertexCount * 3 : name === INDEX_KEY ? fingerprint.indexCount : undefined);
    if (expectedLength !== undefined && expectedLength !== current.length) {
      if (!counted.has(name)) failures.push(new ParityFailure({ mesh: mesh.name, attribute: name, kind: KIND_COUNT, detail: `${name} holds ${current.length} values, frozen with ${expectedLength}`, differingElements: 0, differences: [] }));
      continue;
    }
    if (hashBuffer(name, current) === fingerprint.hashes[name]) continue;
    const diff = frozen?.length ? firstDifferences(name, frozen, current) : { count: 0, values: [] as ElementDifferenceValue[] };
    const detail = !frozen || frozen.length === 0
      ? "hash mismatch; the compact manifest did not retain values for a first-element report"
      : diff.count === 0
        ? "the payload buffer matches the manifest's retained buffer but not its recorded hash"
        : `first difference at element ${diff.values[0]!.index}: ${diff.values[0]!.frozen} -> ${diff.values[0]!.current} (${diff.count} of ${frozen.length} elements differ)`;
    failures.push(new ParityFailure({ mesh: mesh.name, attribute: name, kind: KIND_HASH, detail, differingElements: diff.count, differences: diff.values }));
  }
  return { failures, additions };
}

export function verify(manifest: Manifest | undefined | null, payload: unknown): ParityReport {
  if (!manifest) return new ParityReport({ status: STATUS_UNEVALUATED, meshesFrozen: 0, meshesCompared: 0, failureCount: 0, failures: [], additionCount: 0, additions: [], reason: NO_MANIFEST_REASON });
  if (manifest.schemaVersion !== SCHEMA_VERSION) return new ParityReport({ status: STATUS_UNEVALUATED, meshesFrozen: manifest.meshes.length, meshesCompared: 0, failureCount: 0, failures: [], additionCount: 0, additions: [], reason: `manifest schemaVersion ${manifest.schemaVersion} is not ${SCHEMA_VERSION}` });
  if (manifest.frozenAttributes.join(",") !== FROZEN_BUFFERS.join(",")) return new ParityReport({ status: STATUS_UNEVALUATED, meshesFrozen: manifest.meshes.length, meshesCompared: 0, failureCount: 0, failures: [], additionCount: 0, additions: [], reason: `manifest was frozen over ${manifest.frozenAttributes}, this module freezes ${FROZEN_BUFFERS}` });
  if (manifest.meshes.length === 0) return new ParityReport({ status: STATUS_UNEVALUATED, meshesFrozen: 0, meshesCompared: 0, failureCount: 0, failures: [], additionCount: 0, additions: [], reason: EMPTY_MANIFEST_REASON });
  const current = readMeshes(payload);
  const failures: ParityFailure[] = [];
  const additions: string[] = [];
  const manifestDuplicates = duplicates(manifest.meshes.map((mesh) => mesh.name));
  const payloadDuplicates = duplicates(current.map((mesh) => mesh.name));
  for (const [name, count] of manifestDuplicates) failures.push(new ParityFailure({ mesh: name, attribute: null, kind: KIND_DUPLICATE, detail: `the freeze manifest records ${count} meshes named ${name}`, differingElements: 0, differences: [] }));
  for (const [name, count] of payloadDuplicates) failures.push(new ParityFailure({ mesh: name, attribute: null, kind: KIND_DUPLICATE, detail: `the payload carries ${count} meshes named ${name}`, differingElements: 0, differences: [] }));
  const ambiguous = new Set([...manifestDuplicates, ...payloadDuplicates].map(([name]) => name));
  const byName = new Map(current.filter((mesh) => !ambiguous.has(mesh.name)).map((mesh) => [mesh.name, mesh]));
  const frozenNames = new Set(manifest.meshes.map((mesh) => mesh.name));
  let compared = 0;
  for (const fingerprint of manifest.meshes) {
    if (ambiguous.has(fingerprint.name)) continue;
    const mesh = byName.get(fingerprint.name);
    if (!mesh) {
      failures.push(new ParityFailure({ mesh: fingerprint.name, attribute: null, kind: KIND_MESH_MISSING, detail: `frozen with ${fingerprint.vertexCount} vertices and absent from the payload`, differingElements: 0, differences: [] }));
      continue;
    }
    const result = compareMesh(fingerprint, mesh);
    failures.push(...result.failures);
    additions.push(...result.additions);
    compared += 1;
  }
  for (const mesh of current) {
    if (ambiguous.has(mesh.name) || frozenNames.has(mesh.name)) continue;
    failures.push(new ParityFailure({ mesh: mesh.name, attribute: null, kind: KIND_MESH_ADDED, detail: `present in the payload with ${Math.floor((mesh.buffers.position?.length ?? 0) / 3)} vertices and not in the manifest`, differingElements: 0, differences: [] }));
  }
  return new ParityReport({ status: failures.length ? STATUS_FAIL : STATUS_PASS, meshesFrozen: manifest.meshes.length, meshesCompared: compared, failureCount: failures.length, failures: failures.slice(0, 20), additionCount: additions.length, additions: additions.slice(0, 20) });
}

export const load_payload = loadPayload;
export const hash_buffer = hashBuffer;
