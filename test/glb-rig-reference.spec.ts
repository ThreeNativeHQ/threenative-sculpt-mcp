import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseGlb,
  readRig,
  resolveLandmarks,
  sampleClips,
  slerp,
  UnsupportedInterpolation
} from "../src/glb-rig-reference.js";

function fixtureGlb(options: { skins?: number; interpolation?: string } = {}): Buffer {
  const bytes: number[] = [];
  const views: Array<Record<string, number>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const add = (values: number[], type: string, count: number, extra: Record<string, unknown> = {}) => {
    while (bytes.length % 4) bytes.push(0);
    const offset = bytes.length;
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
    bytes.push(...buffer);
    views.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length });
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count, type, ...extra });
    return accessors.length - 1;
  };
  const position = add([-0.5, 0, 0, 0.5, 1, 0, 0, 0.5, 0], "VEC3", 3, { min: [-0.5, 0, 0], max: [0.5, 1, 0] });
  const times = add([0, 1], "SCALAR", 2, { min: [0], max: [1] });
  const hipTrack = add([0, 0.5, 0, 0, 0.5, 1], "VEC3", 2);
  const matrices = add(Array.from({ length: 16 }, (_, index) => index % 5 === 0 ? 1 : 0), "MAT4", 1);
  const nodes = [
    { name: "root", children: [1, 2, 3, 4, 5, 6, 7] },
    { name: "Hip", translation: [0, 0.5, 0] },
    { name: "Head", translation: [0, 1, 0] },
    { name: "L_Hand", translation: [0.3, 0.6, 0] },
    { name: "R_Hand", translation: [-0.3, 0.6, 0] },
    { name: "L_ToeBase", translation: [0.1, 0, 0] },
    { name: "R_ToeBase", translation: [-0.1, 0, 0] },
    { name: "mesh", mesh: 0, skin: 0 }
  ];
  const skins = Array.from({ length: options.skins ?? 1 }, (_, index) => ({ name: `skin-${index}`, joints: [2, 5, 1, 6, 3, 4], inverseBindMatrices: matrices }));
  const document = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    meshes: [{ name: "body", primitives: [{ attributes: { POSITION: position } }] }],
    skins, buffers: [{ byteLength: bytes.length }], bufferViews: views, accessors,
    animations: [{ name: "walk", samplers: [{ input: times, output: hipTrack, interpolation: options.interpolation ?? "LINEAR" }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }] }]
  };
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const binary = Buffer.from(bytes);
  const paddedBinary = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)]);
  const body = Buffer.concat([
    (() => { const header = Buffer.alloc(8); header.writeUInt32LE(paddedJson.length, 0); header.writeUInt32LE(0x4e4f534a, 4); return header; })(),
    paddedJson,
    (() => { const header = Buffer.alloc(8); header.writeUInt32LE(paddedBinary.length, 0); header.writeUInt32LE(0x004e4942, 4); return header; })(),
    paddedBinary
  ]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + body.length, 8);
  return Buffer.concat([header, body]);
}

async function fixtureFile(options: { skins?: number; interpolation?: string } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "sculpt-rig-"));
  const file = path.join(directory, "character.glb");
  await writeFile(file, fixtureGlb(options));
  return file;
}

describe("GLB rig reference", () => {
  it("reads skin order rather than traversal order and samples the GLB channels", async () => {
    const file = await fixtureFile();
    const rig = readRig(file);
    expect(rig.joints.map((joint) => joint.nodeIndex)).toEqual([2, 5, 1, 6, 3, 4]);
    expect(rig.inverseBindSource).toBe("accessor:3");
    const landmarks = resolveLandmarks(rig, { hip: "Hip", head: "Head", "hand.l": "L_Hand", "hand.r": "R_Hand", "foot.l": "L_ToeBase", "foot.r": "R_ToeBase" });
    const sampled = sampleClips(rig, landmarks);
    expect(sampled.clips).toHaveLength(1);
    expect((sampled.clips[0] as { sampleTimes: number[] }).sampleTimes).toHaveLength(25);
    expect(rig.deformVsTechnical).toMatchObject({ status: "evaluated", channelsTargetingJoints: 1 });
  });

  it("fails on truncated binaries, ambiguous skins and unsupported interpolation", async () => {
    const file = await fixtureFile();
    const parsed = parseGlb(file);
    expect(parsed.bin.length).toBeGreaterThan(0);
    await writeFile(file, fixtureGlb().subarray(0, -2));
    expect(() => readRig(file)).toThrow(/truncated/i);
    const multi = await fixtureFile({ skins: 2 });
    expect(readRig(multi).structuralFailure).toContain("2 skins");
    const unsupported = await fixtureFile({ interpolation: "CUBICSPLINE" });
    const rig = readRig(unsupported);
    expect(() => sampleClips(rig, resolveLandmarks(rig, { hip: "Hip", head: "Head", "hand.l": "L_Hand", "hand.r": "R_Hand", "foot.l": "L_ToeBase", "foot.r": "R_ToeBase" }))).toThrow(UnsupportedInterpolation);
  });

  it("uses spherical interpolation for rotation channels", () => {
    const half = slerp([0, 0, 0, 1], [0, 0, 1, 0], 0.5);
    expect(half[2]).toBeCloseTo(Math.SQRT1_2);
    expect(half[3]).toBeCloseTo(Math.SQRT1_2);
  });
});
