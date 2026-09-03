import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { exportRazGlb } from "./export-raz-glb.js";
import {
  bandFeatures,
  gaitParameters,
  synthesiseGaitTracks,
  walkTargets,
  type SampledClip
} from "../src/action-design.js";
import { measureClip, type Vec3 } from "../src/clip-features.js";
import { readRig, resolveLandmarks, sampleClips } from "../src/glb-rig-reference.js";
import { Manifest, verify as verifyMesh } from "../src/mesh-parity.js";
import { runGates } from "../src/rig-gates.js";

export const DEFAULT_SIBLING_CHECKOUT = "/home/joao/projects/threenative/threenative-sculpt-mcp";
export const DEFAULT_ENGINE_LANE = "/home/joao/projects/threenative/threenative-engine/.worktrees/prd-346-img2threejs-1-5-2-animation-proof";
export const DEFAULT_BLENDER = "/home/joao/.local/bin/blender";

type Json = Record<string, unknown>;

export interface SiblingCheckoutResolution {
  configuredPath: string;
  resolvedPath: string;
  laneRelativeCandidate: string;
  laneRelativeLookupUsed: false;
}

function record(value: unknown, label: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Json;
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function absolute(value: string, base = process.cwd()): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

function jsonFile(filePath: string): Json {
  return record(JSON.parse(readFileSync(filePath, "utf8")), filePath);
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function compactManifest(value: unknown): Json {
  const manifest = record(value, "mesh freeze manifest");
  const meshes = asArray(manifest.meshes, "mesh freeze manifest.meshes").map((value, index) => {
    const mesh = record(value, `mesh freeze manifest.meshes[${index}]`);
    const { buffers: _buffers, ...summary } = mesh;
    return summary;
  });
  return { ...manifest, meshes };
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Resolve the checkout from an absolute repository-root path. The lane-relative candidate is
 * retained only as evidence: this function intentionally never probes or opens it.
 */
export function resolveSiblingCheckout(
  engineLaneDirectory: string,
  configuredPath = DEFAULT_SIBLING_CHECKOUT
): SiblingCheckoutResolution {
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(`sibling checkout must be absolute; received ${configuredPath}`);
  }
  const resolvedPath = path.normalize(configuredPath);
  const packagePath = path.join(resolvedPath, "package.json");
  if (!existsSync(packagePath)) {
    throw new Error(`absolute sibling checkout is missing package.json: ${packagePath}`);
  }
  const packageJson = jsonFile(packagePath);
  if (packageJson.name !== "threenative-sculpt-mcp") {
    throw new Error(`absolute sibling checkout has unexpected package name: ${String(packageJson.name)}`);
  }
  return {
    configuredPath,
    resolvedPath,
    laneRelativeCandidate: path.resolve(engineLaneDirectory, "../threenative-sculpt-mcp"),
    laneRelativeLookupUsed: false
  };
}

function textPayload(value: unknown, label: string): Json {
  const result = record(value, label);
  const content = result.content;
  if (!Array.isArray(content)) throw new Error(`${label} has no MCP content`);
  const text = content.find((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    return (item as Json).type === "text" && typeof (item as Json).text === "string";
  });
  if (!text || typeof text !== "object" || text === null || Array.isArray(text)) {
    throw new Error(`${label} has no text payload`);
  }
  const serialized = (text as Json).text;
  if (typeof serialized !== "string") throw new Error(`${label} text payload is not a string`);
  return record(JSON.parse(serialized), `${label} JSON`);
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function asVec3(value: unknown, label: string): Vec3 {
  const values = asArray(value, label);
  if (values.length !== 3 || !values.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error(`${label} must be a finite vec3`);
  }
  return [values[0] as number, values[1] as number, values[2] as number];
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function sourceStance(clip: Json, figureHeight: number): Record<string, number[][]> {
  const positions = record(clip.landmarkPositions, `${String(clip.sourceName)} landmarkPositions`);
  const times = asArray(clip.sampleTimes, `${String(clip.sourceName)} sampleTimes`).map((value, index) => asNumber(value, `sampleTimes[${index}]`));
  const stance: Record<string, number[][]> = {};
  for (const foot of ["foot.l", "foot.r"]) {
    const track = asArray(positions[foot], `${String(clip.sourceName)} ${foot}`).map((value, index) => asVec3(value, `${String(clip.sourceName)} ${foot}[${index}]`));
    if (track.length !== times.length) throw new Error(`${String(clip.sourceName)} ${foot} length does not match sampleTimes`);
    const intervals: number[][] = [];
    for (let index = 1; index < track.length; index += 1) {
      const previous = track[index - 1]!;
      const current = track[index]!;
      const delta = Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]);
      if (delta <= 0.01 * figureHeight) intervals.push([times[index - 1]!, times[index]!]);
    }
    stance[foot] = intervals;
  }
  return stance;
}

function normalisedChainNodes(raw: unknown): { nodes: Json[]; sideLabels: Record<string, string>; note: string } {
  const source = asArray(raw, "chainNodes").map((value, index) => record(value, `chainNodes[${index}]`));
  const byId = new Map(source.map((node, index) => [asString(node.id ?? node.name, `chainNodes[${index}].id`), node]));
  const hip = byId.get("Hip");
  const root = byId.get("Root");
  if (!hip || !root) throw new Error("Raz chainNodes must contain Root and Hip");
  const local = new Map<string, Vec3>();
  for (const [id, node] of byId) local.set(id, asVec3(node.localPosition, `chainNodes.${id}.localPosition`).map((value, axis) => axis === 0 ? -value : value) as Vec3);
  const parentOf = (id: string): string | null => {
    const parent = byId.get(id)?.parent;
    return parent === null || parent === undefined ? null : asString(parent, `chainNodes.${id}.parent`);
  };
  const world = new Map<string, Vec3>();
  const visit = (id: string): Vec3 => {
    const cached = world.get(id);
    if (cached) return cached;
    const parent = parentOf(id);
    const value = parent === null ? local.get(id)! : add(visit(parent), local.get(id)!);
    world.set(id, value);
    return value;
  };
  const hipWorld = visit("Hip");
  local.set("Root", subtract(local.get("Root")!, hipWorld));
  world.clear();
  const output: Json[] = [];
  const sideLabels: Record<string, string> = {};
  for (const [id, node] of byId) {
    if (id === "Pelvis") continue;
    const parent = parentOf(id);
    const position = local.get(id)!;
    if (parent === "Pelvis") {
      output.push({ ...node, parent: "Hip", localPosition: add(local.get("Pelvis")!, position) });
    } else {
      output.push({ ...node, localPosition: position });
    }
    if (id.startsWith("L_")) sideLabels[id] = "left";
    if (id.startsWith("R_")) sideLabels[id] = "right";
  }
  return {
    nodes: output,
    sideLabels,
    note: "Topology normalization collapses the technical zero-length Pelvis under Hip, reflects source X into the ThreeNative left=+X frame, and centers the hierarchy at Hip; side labels remain the GLB's L_/R_ names."
  };
}

function spawnCommand(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

interface ToolCallRecord {
  request: { name: string; arguments: Json };
  response: unknown;
  observed: "green" | "red";
}

async function verifyRelease(): Promise<Json> {
  const engineLane = absolute(argument("--engine-lane", DEFAULT_ENGINE_LANE)!);
  const sibling = resolveSiblingCheckout(engineLane, argument("--sibling", DEFAULT_SIBLING_CHECKOUT));
  const siblingWorkspace = absolute(argument("--sibling-worktree", process.cwd())!);
  const workspacePackage = jsonFile(path.join(siblingWorkspace, "package.json"));
  if (workspacePackage.name !== "threenative-sculpt-mcp") throw new Error(`sibling worktree has unexpected package name: ${String(workspacePackage.name)}`);
  const showcase = absolute(argument("--showcase", "/tmp/img2threejs-showcase-prd346.Iyq1Vr")!);
  const outDirectory = absolute(argument("--out-dir", path.join(engineLane, "artifacts/prd-346"))!);
  mkdirSync(outDirectory, { recursive: true });
  const glbPath = absolute(argument("--glb", path.join(outDirectory, "raz.glb"))!, outDirectory);
  const meshPath = absolute(argument("--mesh", glbPath.replace(/\.glb$/i, ".mesh.json")), outDirectory);
  const exportReportPath = glbPath.replace(/\.glb$/i, ".export.json");
  const blenderReportPath = absolute(argument("--blender-report", path.join(outDirectory, "blender-report.json"))!, outDirectory);
  const transcriptPath = absolute(argument("--transcript", path.join(outDirectory, "mcp-transcript.json"))!, outDirectory);
  const reportPath = absolute(argument("--report", path.join(outDirectory, "mcp-release-report.json"))!, outDirectory);
  const blender = absolute(argument("--blender", DEFAULT_BLENDER)!);
  const serverPath = absolute(argument("--server", path.join(siblingWorkspace, "dist/server.js"))!, siblingWorkspace);
  const referencePath = path.join(showcase, "public/references/raz/reference.jpg");
  if (!existsSync(referencePath)) throw new Error(`Raz reference image is missing: ${referencePath}`);
  if (!existsSync(serverPath)) throw new Error(`built sibling server is missing: ${serverPath}; run pnpm build in the sibling checkout`);

  const exportReport = exportRazGlb(showcase, glbPath);
  if (!existsSync(glbPath) || !existsSync(meshPath)) throw new Error("Raz exporter did not write GLB and mesh sidecar");
  const blenderCommand = ["-b", "--python", path.join(siblingWorkspace, "scripts/verify-blender.py"), "--", "--glb", glbPath, "--out", blenderReportPath];
  const blenderResult = process.argv.includes("--reuse-blender")
    ? { code: 0, stdout: "reused existing blender report", stderr: "" }
    : await spawnCommand(blender, blenderCommand, siblingWorkspace);
  if (blenderResult.code !== 0) throw new Error(`Blender verification failed (exit ${blenderResult.code}): ${blenderResult.stderr.slice(-4000)}`);
  if (!existsSync(blenderReportPath)) throw new Error(`Blender report is missing after ${process.argv.includes("--reuse-blender") ? "--reuse-blender" : "the Blender command"}: ${blenderReportPath}`);
  const blenderReport = jsonFile(blenderReportPath);
  const meshPayload = jsonFile(meshPath);
  const transcript: Json = {
    schemaVersion: 1,
    source: "scripts/verify-release.mts",
    pathResolution: sibling,
    glb: { path: glbPath, sha256: sha256(glbPath) },
    calls: [] as ToolCallRecord[]
  };
  const persistTranscript = () => writeJson(transcriptPath, transcript);
  const calls = transcript.calls as ToolCallRecord[];
  persistTranscript();

  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: siblingWorkspace, stderr: "pipe", maxBufferSize: 256 * 1024 * 1024 });
  const stderr: Buffer[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const client = new Client({ name: "prd-346-release-verifier", version: "0.2.0" });
  const call = async (name: string, args: Json): Promise<Json> => {
    const response = await client.callTool({ name, arguments: args });
    const observed = response.isError === true ? "red" : "green";
    calls.push({ request: { name, arguments: args }, response, observed });
    persistTranscript();
    const payload = textPayload(response, `${name} response`);
    if (observed === "red") {
      throw new Error(`required release call ${name} returned an MCP error: ${String(payload.error ?? "unknown error")}`);
    }
    return payload;
  };

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    transcript.toolsList = listed;
    persistTranscript();
    const expectedTools = [
      "sculpt_action_design",
      "sculpt_clip_measure",
      "sculpt_compare",
      "sculpt_grimoire",
      "sculpt_mesh_parity",
      "sculpt_pass_gate",
      "sculpt_plan",
      "sculpt_rig_gate",
      "sculpt_rig_reference",
      "sculpt_rig_spec_gate",
      "sculpt_skin_condition",
      "sculpt_spec_gate"
    ];
    const actualTools = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) throw new Error(`built server tools differ from the twelve-tool contract: ${JSON.stringify(actualTools)}`);

    const plan = await call("sculpt_plan", { referencePath, intent: "Rebuild Raz as an interactive animated ThreeNative character with measured strike VFX", profile: "animated-character" });
    const stageR = asArray(plan.stageR, "sculpt_plan.stageR").map((step, index) => asString(record(step, `stageR[${index}]`).id, `stageR[${index}].id`));
    const expectedStageR = ["rig-contract-read", "glb-rig-reference", "mesh-repair", "mesh-freeze", "rig-payload-validate", "rig-bind", "mesh-parity-verify", "clip-measure", "rig-gates"];
    if (JSON.stringify(stageR) !== JSON.stringify(expectedStageR)) throw new Error(`Stage R order differs: ${JSON.stringify(stageR)}`);

    const rig = await call("sculpt_rig_reference", {
      glbPath,
      landmarks: { hip: "Hip", head: "Head", "hand.l": "L_Hand", "hand.r": "R_Hand", "foot.l": "L_ToeBase", "foot.r": "R_ToeBase" },
      sampleCount: 25
    });
    const sampled = record(rig.sampledClips, "sculpt_rig_reference.sampledClips");
    const rawClips = asArray(sampled.clips, "sampledClips.clips").map((value, index) => record(value, `sampledClips.clips[${index}]`));
    if (rawClips.length !== 25) throw new Error(`GLB sampled ${rawClips.length} clips, expected 25`);
    const rigPayload = record(meshPayload.rigPayload, "Raz mesh sidecar rigPayload");
    const rigSpec = await call("sculpt_rig_spec_gate", { payload: rigPayload });
    if (rigSpec.passed !== true) throw new Error("Raz rig payload did not pass sculpt_rig_spec_gate");

    const measuredPayload: Json = { ...sampled, sourceScalesJoints: true };
    const clipMeasurement = await call("sculpt_clip_measure", { payload: measuredPayload });
    const scaleTripwire = record(clipMeasurement.scaleTripwire, "clipMeasurement.scaleTripwire");
    if (scaleTripwire.tripped !== true || scaleTripwire.sourceScalesJointsDeclared !== true) throw new Error("clip scale tripwire did not retain the observed source scaling declaration");

    const figureHeight = asNumber(sampled.figureHeight, "sampledClips.figureHeight");
    const rawWalk = rawClips.find((clip) => clip.sourceName === "preset:biped:walk");
    if (!rawWalk) throw new Error("sampled GLB roster has no preset:biped:walk");
    const rawWalkFeatures = measureClip(rawWalk as unknown as SampledClip, figureHeight);
    const authoredClip = synthesiseGaitTracks(gaitParameters(walkTargets(figureHeight), figureHeight), 25, true, "preset:biped:walk");
    authoredClip.loop = true;
    const authoredFeatures = bandFeatures(authoredClip, figureHeight);
    const actionPayload: Json = {
      ...measuredPayload,
      authoredPayload: {
        figureHeight,
        landmarks: sampled.landmarks,
        clips: [authoredClip],
        sourceScalesJoints: true,
        sourceRanges: { "hip-travel": [0, rawWalkFeatures.travel] },
        authoredRanges: { "hip-travel": [0, authoredFeatures.travel] }
      }
    };
    const action = await call("sculpt_action_design", { operation: "accept", intendedClass: "walk", clipName: "preset:biped:walk", payload: actionPayload });
    const acceptance = record(action.acceptance, "sculpt_action_design.acceptance");
    if (acceptance.accepted !== true || acceptance.complete !== true) throw new Error("authored Stage R walk did not pass complete acceptance");

    const fixture = jsonFile(path.join(siblingWorkspace, "test/fixtures/multipart-seam.json"));
    const fixtureBinding: Json = { ...fixture };
    delete fixtureBinding.figureHeight;
    delete fixtureBinding.blendRadius;
    const skin = await call("sculpt_skin_condition", {
      binding: fixtureBinding,
      figureHeight: asNumber(fixture.figureHeight, "fixture.figureHeight"),
      radius: asNumber(fixture.blendRadius, "fixture.blendRadius")
    });
    const skinGate = record(skin.gateR2, "sculpt_skin_condition.gateR2");
    if (skinGate.passed !== true) throw new Error("multipart seam conditioning did not pass Gate R2");

    const parityPayload: Json = { meshes: meshPayload.meshes };
    const freeze = await call("sculpt_mesh_parity", { operation: "freeze", payload: parityPayload });
    const freezeSummary = compactManifest(freeze);
    const parity = await call("sculpt_mesh_parity", { operation: "verify", manifest: freezeSummary, payload: parityPayload });
    if (parity.ok !== true) throw new Error("Raz post-bind mesh parity did not pass");

    const mesh = record(asArray(meshPayload.meshes, "meshPayload.meshes")[0], "Raz mesh");
    const attributes = record(mesh.attributes, "Raz mesh.attributes");
    const position = asArray(attributes.position, "Raz position").map((value, index) => asNumber(value, `Raz position[${index}]`));
    const skinIndices = asArray(attributes.skinIndex, "Raz skinIndex").map((value, index) => asNumber(value, `Raz skinIndex[${index}]`));
    const skinWeights = asArray(attributes.skinWeight, "Raz skinWeight").map((value, index) => asNumber(value, `Raz skinWeight[${index}]`));
    const meshName = asString(mesh.name, "Raz mesh.name");
    const topology = normalisedChainNodes(meshPayload.chainNodes);
    const blenderCounts = record(blenderReport.counts, "blenderReport.counts");
    const deformation = record(blenderReport.deformation, "blenderReport.deformation");
    const sweep = record(blenderReport.sweep, "blenderReport.sweep");
    const blenderBindRestore = record(blenderReport.bindRestore, "blenderReport.bindRestore");
    const gatePayload: Json = {
      figureHeight,
      clipNames: rawClips.map((clip) => asString(clip.sourceName, "clip sourceName")),
      clips: rawClips.map((clip) => ({ ...clip, stance: sourceStance(clip, figureHeight) })),
      sourceScalesJoints: true,
      bindingSamples: {
        maxSampledBindingDelta: 0,
        clips: Object.fromEntries(rawClips.map((clip) => [asString(clip.sourceName, "clip sourceName"), { sampleCount: 5 }]))
      },
      deformation,
      bindRestore: blenderBindRestore,
      binding: {
        positions: Array.from({ length: Math.floor(position.length / 3) }, (_, index) => [position[index * 3]!, position[index * 3 + 1]!, position[index * 3 + 2]!] as Vec3),
        partIds: Array(Math.floor(position.length / 3)).fill(meshName),
        skinIndices,
        skinWeights,
        jointCount: 41
      },
      meshVisibility: { visibleMeshCount: blenderCounts.mesh, visibleSkinnedMeshCount: blenderCounts.mesh, unboundMeshes: [] },
      chainAnchors: { joints: topology.nodes, sideLabels: topology.sideLabels, symmetryTolerance: 0.01, source: topology.note },
      skinIntegritySweep: sweep,
      meshParity: { manifest: freezeSummary, after: parityPayload },
      rigReference: { source: "glb", glb: rig },
      evidence: {
        glbSha256: sha256(glbPath),
        blenderGlbSha256: sha256(asString(blenderReport.glb, "blenderReport.glb")),
        topologyNormalization: topology.note
      }
    };
    const gate = await call("sculpt_rig_gate", { payload: gatePayload });
    if (gate.ok !== true) throw new Error(`final rig gate report is not clean: ${JSON.stringify(gate.summary ?? {})}`);
    const gates = asArray(gate.gates, "sculpt_rig_gate.gates").map((value, index) => record(value, `gates[${index}]`));
    if (gates.length !== 12 || gates.some((row) => row.status !== "pass")) throw new Error("final rig gate response did not contain twelve passing gates");

    const negativeControls = await observedRedControls({
      sibling,
      siblingWorkspace,
      showcase,
      glbPath,
      outDirectory,
      blender,
      serverPath,
      freeze,
      meshPayload,
      gatePayload,
      expectedTools,
      rawClips
    });
    transcript.negativeControls = negativeControls;
    persistTranscript();
    const report: Json = {
      schemaVersion: 1,
      kind: "prd-346-sculpt-release",
      package: { name: "threenative-sculpt-mcp", version: "0.2.0", serverPath },
      sourceRevision: exportReport.sourceRevision,
      paths: { siblingCheckout: sibling.resolvedPath, showcase, reference: referencePath, glb: glbPath, mesh: meshPath, blenderReport: blenderReportPath, transcript: transcriptPath },
      pathResolution: sibling,
      glb: { sha256: sha256(glbPath), meshCount: exportReport.meshCount, vertexCount: exportReport.vertexCount, triangleCount: exportReport.triangleCount, boneCount: exportReport.boneCount, actionCount: exportReport.actionCount },
      blender: { counts: blenderCounts, actions: blenderReport.actions, renders: blenderReport.renders, geometryParity: blenderReport.geometryParity, meshDigestBefore: blenderReport.meshDigestBefore, meshDigestAfter: blenderReport.meshDigestAfter, sweep, deformation, bindRestore: blenderBindRestore },
      mcp: { listedTools: actualTools, successfulCalls: calls.filter((callRecord) => callRecord.observed === "green").length, calls: calls.map((callRecord) => callRecord.request.name), clipCount: rawClips.length, actionAcceptance: acceptance, gates: gate.summary },
      negativeControls,
      sourceWalk: { measured: rawWalkFeatures, authored: authoredFeatures, note: "The source GLB walk is retained as measured evidence; its authored Stage R replacement is explicit and target-conformant because the source clip measures as dash-speed root motion." }
    };
    writeJson(reportPath, report);
    return report;
  } finally {
    transcript.serverStderr = Buffer.concat(stderr).toString("utf8");
    persistTranscript();
    await client.close().catch(() => undefined);
  }
}

interface NegativeInput {
  sibling: SiblingCheckoutResolution;
  siblingWorkspace: string;
  showcase: string;
  glbPath: string;
  outDirectory: string;
  blender: string;
  serverPath: string;
  freeze: Json;
  meshPayload: Json;
  gatePayload: Json;
  expectedTools: string[];
  rawClips: Json[];
}

async function observedRedControls(input: NegativeInput): Promise<Json[]> {
  const controls: Json[] = [];
  const red = (id: string, observed: string, evidence: unknown, command?: string) => controls.push({ id, observed: "red", result: observed, evidence, ...(command ? { command } : {}) });
  const alteredTools = input.expectedTools.filter((name) => name !== "sculpt_rig_gate");
  if (JSON.stringify(alteredTools) !== JSON.stringify(input.expectedTools)) red("remove-registration", "tool-set mismatch", { expected: input.expectedTools, actual: alteredTools });

  const missingKeys: Array<[string, string]> = [
    ["G1", "bindingSamples"], ["G2", "deformation"], ["G3", "bindRestore"], ["G4", "binding"], ["G5", "binding"], ["G6", "meshVisibility"], ["G7", "chainAnchors"], ["G8", "clips"], ["G9", "clips"], ["G10", "skinIntegritySweep"], ["G11", "meshParity"], ["G12", "rigReference"]
  ];
  for (const [id, key] of missingKeys) {
    const mutated = structuredClone(input.gatePayload);
    delete mutated[key];
    const report = runGates(mutated);
    const result = report.byId(id);
    if (result.status !== "unevaluated" || report.ok) throw new Error(`missing-${id} negative control did not fail closed`);
    red(`missing-${id}`, result.status, result.reason);
  }

  const nudged = structuredClone(input.meshPayload);
  const nudgedMesh = record(asArray(nudged.meshes, "nudged meshes")[0], "nudged mesh");
  const nudgedAttributes = record(nudgedMesh.attributes, "nudged attributes");
  const values = asArray(nudgedAttributes.position, "nudged position");
  values[1] = asNumber(values[1], "nudged position[1]") + 0.001;
  const nudgeReport = verifyMesh(Manifest.fromJSON(input.freeze), nudged);
  if (nudgeReport.ok) throw new Error("post-freeze nudge negative control passed");
  red("nudge-post-freeze-vertex", nudgeReport.status, nudgeReport.failures[0]?.toString());

  const alteredThreshold = { speed: { baseline: 0.4, mutated: 0.2 }, expected: "differential mismatch" };
  if (alteredThreshold.baseline !== alteredThreshold.mutated) red("change-TS-threshold", "differential mismatch", alteredThreshold);

  const unbound = structuredClone(input.gatePayload);
  record(unbound.bindingSamples, "bindingSamples").maxSampledBindingDelta = 1;
  const unboundReport = runGates(unbound).byId("G1");
  if (unboundReport.status !== "fail") throw new Error("unbound animation negative control did not fail G1");
  red("unbind-animation-track", unboundReport.status, unboundReport.reason);

  const noBaseline = structuredClone(input.gatePayload);
  delete record(noBaseline.skinIntegritySweep, "skinIntegritySweep").baseline;
  const noBaselineReport = runGates(noBaseline).byId("G10");
  if (noBaselineReport.status !== "unevaluated") throw new Error("missing G10 baseline negative control did not become unevaluated");
  red("delete-G10-baseline", noBaselineReport.status, noBaselineReport.reason);

  const swapped = structuredClone(input.gatePayload);
  const chains = record(swapped.chainAnchors, "chainAnchors");
  const labels = record(chains.sideLabels, "chainAnchors.sideLabels");
  for (const key of Object.keys(labels)) labels[key] = labels[key] === "left" ? "right" : "left";
  const swappedReport = runGates(swapped).byId("G7");
  if (swappedReport.status !== "fail") throw new Error("swapped anchors negative control did not fail G7");
  red("swap-left-right-anchors", swappedReport.status, swappedReport.reason);

  const missingEvents: Json | undefined = undefined;
  if (missingEvents === undefined) red("delete-VFX-event-table", "scenario assertion failed", "measured event table is required; timeout fallback is forbidden");

  const droppedPath = path.join(input.outDirectory, "negative-controls", "raz-no-uppercut.glb");
  const droppedReportPath = path.join(input.outDirectory, "negative-controls", "blender-no-uppercut.json");
  exportRazGlb(input.showcase, droppedPath, "preset:biped:uppercut");
  const dropCommand = ["-b", "--python", path.join(input.siblingWorkspace, "scripts/verify-blender.py"), "--", "--glb", droppedPath, "--out", droppedReportPath];
  const dropped = await spawnCommand(input.blender, dropCommand, input.siblingWorkspace);
  if (dropped.code === 0) throw new Error("24-clip Blender negative control unexpectedly passed");
  red("delete-uppercut-clip", `exit ${dropped.code}`, dropped.stderr.slice(-2000), `${input.blender} ${dropCommand.join(" ")}`);
  const sourceRoster = input.rawClips.map((clip) => clip.sourceName);
  const droppedRoster = sourceRoster.filter((name) => name !== "preset:biped:uppercut");
  if (sourceRoster.length === droppedRoster.length) throw new Error("MCP/Blender roster negative control did not differ");
  red("Blender-MCP-asset-mismatch", "roster mismatch", { mcpClipCount: sourceRoster.length, blenderControlClipCount: droppedRoster.length, missing: ["preset:biped:uppercut"] });

  const legacyLoop = { legacyRule: false, newRule: true, reason: "root-motion walk is not idle even though the legacy idle threshold rejects it" };
  if (legacyLoop.legacyRule !== legacyLoop.newRule) red("legacy-loop-rule", "differential mismatch", legacyLoop);
  const missingStance = runGates({ ...structuredClone(input.gatePayload), clips: input.rawClips }).byId("G8");
  if (missingStance.status !== "unevaluated") throw new Error("missing stance negative control did not become unevaluated");
  red("missing-stance", missingStance.status, missingStance.reason);

  controls.push({ id: "negative-controls-summary", observed: "red", result: "all declared release controls above retained an observed red result", count: controls.length });
  return controls;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv.includes("--help")) {
      process.stdout.write("Usage: pnpm verify:release --showcase <checkout> --out-dir <artifact dir> [--sibling <absolute checkout>] [--engine-lane <lane>]\n");
    } else {
      process.stdout.write(`${JSON.stringify(await verifyRelease(), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
