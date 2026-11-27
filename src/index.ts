import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  ANIMATION_GRIMOIRE_TOPICS,
  PASS_ORDER,
  SCULPT_PROFILES,
  STAGE_R_STEPS
} from "./constants.js";
import {
  accepts,
  bandFeatures,
  checkMedialLateral,
  footSlide,
  gaitParameters,
  resolveChains,
  runTargets,
  synthesiseGaitTracks,
  targetBandToJSON,
  walkTargets
} from "./action-design.js";
import {
  classify,
  decideLoop,
  loadClipPayload,
  measureClip,
  nameClip,
  report as reportClipFeatures
} from "./clip-features.js";
import { readRig, resolveLandmarks, sampleClips } from "./glb-rig-reference.js";
import { validateRigPayload } from "./rig-payload.js";
import { SkinBinding, blendWeights, validateBinding, validateDiscardReport } from "./skin-conditioning.js";
import { freeze as freezeMesh, Manifest, verify as verifyMesh } from "./mesh-parity.js";
import { runGates } from "./rig-gates.js";
import { gatePass } from "./gate.js";
import { findGrimoirePage, loadGrimoireCatalog } from "./grimoire.js";
import { compareImages, inspectImage } from "./image.js";
import { gateObjectSculptSpec } from "./spec.js";

function response(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {})
  };
}

function failure(error: unknown) {
  return response(
    { error: error instanceof Error ? error.message : String(error), failedClosed: true },
    true
  );
}

function failureWithReport(error: unknown, report: unknown) {
  return response(
    {
      error: error instanceof Error ? error.message : String(error),
      failedClosed: true,
      report
    },
    true
  );
}

function objectPayload(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

const regionSchema = z
  .object({
    id: z.string().trim().min(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1)
  })
  .refine((region) => region.x + region.width <= 1, "x + width must be <= 1")
  .refine((region) => region.y + region.height <= 1, "y + height must be <= 1");

const compareResultSchema = z.object({
  status: z.literal("evidence"),
  authority: z.literal("diagnostic-only"),
  referencePath: z.string(),
  capturePath: z.string(),
  dimensions: z.object({
    reference: z.object({ width: z.number(), height: z.number() }),
    capture: z.object({ width: z.number(), height: z.number() }),
    normalizedForComparison: z.object({ width: z.number(), height: z.number() })
  }),
  overall: z.object({ score: z.number(), confidence: z.number() }),
  regions: z.array(
    z.object({
      id: z.string(),
      pixels: z.number(),
      score: z.number(),
      confidence: z.number(),
      signals: z.object({
        structuralSimilarity: z.number(),
        perceptualHashSimilarity: z.number(),
        colorSimilarity: z.number(),
        deltaE00: z.number()
      }),
      corrections: z.array(z.string())
    })
  ),
  ambiguous: z.boolean(),
  notes: z.array(z.string())
});

function relevantTopics(intent: string, profile: (typeof SCULPT_PROFILES)[number], validTopics: Set<string>): string[] {
  const topics = [
    "intake/image_analysis",
    "intake/detail_inventory",
    "intake/quality_contract",
    "intake/validation_rubric",
    "build/geometry_patterns",
    "feedback/render_capture",
    "review/self_correction",
    "review/gates_reference"
  ];
  if (profile !== "generic" || /character|creature|person|face|humanoid|animal/i.test(intent)) {
    topics.push(
      "character/reconstruction",
      "character/likeness_maximization",
      "character/head_construction",
      "readiness/joint_attachment",
      "readiness/action_rigging"
    );
  }
  if (profile === "animated-character" || /animation|animated|clip|rig|strike|vfx|effect/i.test(intent)) {
    topics.push(...ANIMATION_GRIMOIRE_TOPICS);
  }
  return [...new Set(topics)].filter((topic) => validTopics.has(topic));
}

export async function createSculptServer(): Promise<McpServer> {
  const catalog = await loadGrimoireCatalog();
  const validTopics = new Set(catalog.pages.map((page) => page.topic));
  const server = new McpServer(
    { name: "threenative-sculpt-mcp", version: "0.2.1" },
    {
      instructions:
        "Use sculpt_plan, read its technique-safe grimoire resources, pass sculpt_spec_gate before writing code, then compare each playtest capture and call sculpt_pass_gate. Animated characters must complete the ordered Stage R calls and all rig gates. Pixel metrics never replace semantic image review."
    }
  );

  for (const page of catalog.pages) {
    server.registerResource(
      `grimoire-${page.topic.replaceAll("/", "-")}`,
      page.uri,
      {
        title: page.topic,
        description: "Technique-safe img2threejs grimoire page",
        mimeType: page.mimeType
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: page.mimeType, text: page.text }]
      })
    );
  }

  server.registerTool(
    "sculpt_plan",
    {
      description:
        "Validate a reference image and return the locked eight-pass sculpt order plus relevant technique-safe grimoire resources.",
      inputSchema: z.object({
        referencePath: z.string().trim().min(1),
        intent: z.string().trim().min(1).max(500),
        profile: z.enum(SCULPT_PROFILES).default("generic")
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ referencePath, intent, profile }) => {
      try {
        const image = await inspectImage(referencePath, "reference");
        const topics = relevantTopics(intent, profile, validTopics);
        if (topics.length === 0) throw new Error("no technique-safe grimoire topics are available");
        return response({
          reference: { path: referencePath, width: image.width, height: image.height },
          intent,
          profile,
          passes: PASS_ORDER,
          ...(profile === "animated-character" ? { stageR: STAGE_R_STEPS } : {}),
          grimoireResources: topics.map((topic) => `sculpt://grimoire/${topic}`),
          contract: "write and gate ObjectSculptSpec before authoring src/render source"
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  const specGateInputSchema = z
    .object({
      schemaVersion: z.string().optional().describe('Contract version, e.g. "2.1".'),
      targetName: z.string().optional(),
      suitability: z.enum(["pass", "conditional", "request-input", "stop"]).optional(),
      coordinateFrame: z.record(z.string(), z.unknown()).optional(),
      silhouette: z.record(z.string(), z.unknown()).optional(),
      componentTree: z
        .array(
          z
            .object({
              id: z.string(),
              level: z.enum(["macro", "meso", "micro"]).optional(),
              localFeatures: z.array(z.unknown()).optional()
            })
            .passthrough()
        )
        .optional(),
      materials: z.array(z.object({ id: z.string() }).passthrough()).optional(),
      repetitionSystems: z.array(z.unknown()).optional(),
      proceduralStrategy: z.array(z.string()).optional(),
      preSpecAssessment: z
        .object({
          complexity: z.object({ tier: z.enum(["simple", "moderate", "complex", "ultra-complex"]) }).passthrough(),
          detailInventory: z.object({ details: z.array(z.unknown()) }).passthrough()
        })
        .passthrough()
        .optional()
        .describe("complexity.tier plus detailInventory.details array matching tier minimum."),
      qualityContract: z
        .object({
          minimumSpecDepth: z
            .object({
              macroComponents: z.number().int().min(0),
              mesoComponents: z.number().int().min(0),
              microFeatureGroups: z.number().int().min(0),
              materialLayers: z.number().int().min(0),
              repetitionSystems: z.number().int().min(0),
              reviewViewpoints: z.number().int().min(0)
            })
            .passthrough()
        })
        .passthrough()
        .optional(),
      qualityTargets: z.object({ reviewViewpoints: z.array(z.string()) }).passthrough().optional()
    })
    .passthrough();

  server.registerTool("sculpt_spec_gate", {
      description:
        "Validate the MCP runtime ObjectSculptSpec contract and canonical complexity depth thresholds before code is written.",
      inputSchema: z.object({ spec: specGateInputSchema }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ spec }) => {
      const result = gateObjectSculptSpec(spec);
      if (result.valid) return response(result);
      const tier = result.tier ?? "simple";
      const d = result.requiredDepth;
      const hint = d
        ? `Minimal shape for tier="${tier}": {schemaVersion:"2.1", targetName, suitability:"pass", coordinateFrame:{}, silhouette:{}, componentTree:[{id,level:"macro"|"meso"|"micro",localFeatures:[]}], materials:[{id}], repetitionSystems:[], proceduralStrategy:["..."], preSpecAssessment:{complexity:{tier:"${tier}"}, detailInventory:{details:[{id} x${d.detailInventory}]}}, qualityContract:{minimumSpecDepth:{macroComponents:${d.macroComponents}, mesoComponents:${d.mesoComponents}, microFeatureGroups:${d.microFeatureGroups}, materialLayers:${d.materialLayers}, repetitionSystems:${d.repetitionSystems}, reviewViewpoints:${d.reviewViewpoints}}}, qualityTargets:{reviewViewpoints:[...x${d.reviewViewpoints}]}}.`
        : undefined;
      return response(hint ? { ...result, hint } : result, true);
    }
  );

  server.registerTool(
    "sculpt_compare",
    {
      description:
        "Produce deterministic diagnostic evidence from an existing capture and reference, globally and per normalized region. Never launches a browser and never authorizes advancement.",
      inputSchema: z.object({
        referencePath: z.string().trim().min(1),
        capturePath: z.string().trim().min(1),
        regions: z.array(regionSchema).max(32).default([])
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ referencePath, capturePath, regions }) => {
      try {
        return response(await compareImages(referencePath, capturePath, regions));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "sculpt_pass_gate",
    {
      description:
        "Return advance, retry, or stop. Semantic review controls advancement; deterministic scores supply corrections, while an explicitly ambiguous comparison blocks advancement.",
      inputSchema: z.object({
        passId: z.enum(PASS_ORDER),
        compareResult: compareResultSchema,
        semanticReview: z
          .object({
            score: z.number().min(0).max(1),
            confidence: z.number().min(0).max(1),
            notes: z.string().trim().min(1),
            criticalFeatures: z
              .array(
                z.object({
                  id: z.string().trim().min(1),
                  score: z.number().min(0).max(1),
                  threshold: z.number().min(0).max(1),
                  critical: z.boolean()
                })
              )
              .max(5)
          })
          .optional(),
        threshold: z.number().min(0).max(1).default(0.7),
        minimumConfidence: z.number().min(0).max(1).default(0.65),
        attempt: z.number().int().positive().default(1),
        maxAttempts: z.number().int().positive().default(3)
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ semanticReview, ...input }) =>
      response(gatePass(semanticReview ? { ...input, semanticReview } : input))
  );

  server.registerTool(
    "sculpt_grimoire",
    {
      description:
        "Fetch a technique-safe grimoire page by topic. Unknown and concrete shader/material recipe topics fail and list valid topics.",
      inputSchema: z.object({ topic: z.string().trim().min(1) }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ topic }) => {
      try {
        const page = findGrimoirePage(catalog, topic);
        return response({ topic: page.topic, uri: page.uri, mimeType: page.mimeType, text: page.text });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "sculpt_clip_measure",
    {
      description:
        "Measure every sampled animation clip, classify all matching motion labels, name intent honestly, decide looping from pose return, and surface joint scale.",
      inputSchema: z.object({ payload: z.unknown() }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ payload }) => {
      try {
        const result = reportClipFeatures(payload);
        const tripwire = result.scaleTripwire as { tripped: boolean };
        const sourceScalesJoints = typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).sourceScalesJoints
          : undefined;
        return tripwire.tripped && sourceScalesJoints !== true
          ? failureWithReport("joint scale tripwire tripped; skin conditioning must not proceed", result)
          : response(result);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "sculpt_rig_reference",
    {
      description:
        "Read the GLB's own skin joint order, inverse binds, animation channels and sampled landmark clips; ambiguous skins, landmarks and interpolation fail closed.",
      inputSchema: z
        .object({
          glbPath: z.string().trim().min(1),
          skinIndex: z.number().int().nonnegative().optional(),
          landmarks: z.record(z.string(), z.union([z.string(), z.number().int().nonnegative()])).optional(),
          sampleCount: z.number().int().min(2).max(1000).default(25),
          figureHeight: z.number().positive().optional()
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ glbPath, skinIndex, landmarks, sampleCount, figureHeight }) => {
      try {
        const rig = readRig(glbPath);
        if (skinIndex !== undefined) {
          const selected = rig.skins.find((skin) => skin.skinIndex === skinIndex);
          if (!selected) return failureWithReport(`skinIndex ${skinIndex} is not present in the GLB`, rig.toJSON());
          rig.primarySkin = selected;
          rig.structuralFailure = null;
        }
        const base = rig.toJSON();
        if (rig.structuralFailure) return failureWithReport(rig.structuralFailure, base);
        if (!landmarks) return response(base);
        const landmarkNodeIndices = resolveLandmarks(rig, landmarks);
        const sampled = sampleClips(rig, landmarkNodeIndices, sampleCount, figureHeight);
        return response({ ...base, sampledClips: sampled });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "sculpt_rig_spec_gate",
    {
      description:
        "Validate a structural Stage R rig payload: hierarchy, matrices, four-slot weights, joint indices and coverage.",
      inputSchema: z.object({ payload: z.record(z.string(), z.unknown()) }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ payload }) => {
      const result = validateRigPayload(payload);
      return result.passed ? response(result) : response(result, true);
    }
  );

  server.registerTool(
    "sculpt_skin_condition",
    {
      description:
        "Blend four-slot skin weights across nearby multipart seams, report the deliberate crease trade, and fail if Gate R2 rejects the result.",
      inputSchema: z
        .object({
          binding: z.unknown(),
          figureHeight: z.number().positive(),
          radius: z.number().positive().optional()
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ binding, figureHeight, radius }) => {
      try {
        const result = blendWeights(SkinBinding.fromJSON(binding), figureHeight, radius);
        const failures = [...validateBinding(result.binding), ...validateDiscardReport(result.report)];
        const output = {
          schemaVersion: 1,
          kind: "blended-skin-binding",
          binding: result.binding.toJSON(),
          report: result.report.toJSON(),
          gateR2: { passed: failures.length === 0, failures }
        };
        return failures.length === 0 ? response(output) : response(output, true);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "sculpt_mesh_parity",
    {
      description:
        "Freeze packed position, normal, UV and index buffers before rigging or verify them afterward; skin attributes are legal additions.",
      inputSchema: z
        .object({
          operation: z.enum(["freeze", "verify"]),
          payload: z.unknown(),
          manifest: z.unknown().optional()
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ operation, payload, manifest }) => {
      try {
        if (operation === "freeze") return response(freezeMesh(payload).toJSON());
        if (!manifest) return failure("verify requires a freeze manifest");
        const report = verifyMesh(Manifest.fromJSON(manifest), payload);
        return report.ok ? response(report.toJSON()) : response(report.toJSON(), true);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "sculpt_action_design",
    {
      description:
        "Resolve topology-based limb chains, measure foot contact, accept a measured clip against walk/run targets, or synthesize an explicit gait payload.",
      inputSchema: z
        .object({
          operation: z.enum(["resolve-chains", "foot-slide", "accept", "synthesize"]),
          nodes: z.array(z.unknown()).optional(),
          sideLabels: z.record(z.string(), z.string()).optional(),
          payload: z.record(z.string(), z.unknown()).optional(),
          clipName: z.string().trim().min(1).optional(),
          intendedClass: z.enum(["walk", "run"]).optional(),
          figureHeight: z.number().positive().optional(),
          limit: z.number().nonnegative().optional()
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async (input) => {
      try {
        if (input.operation === "resolve-chains") {
          if (!input.nodes) throw new Error("resolve-chains requires nodes");
          const chains = resolveChains(input.nodes, input.sideLabels);
          return response({ chains, medialLateral: checkMedialLateral(chains) });
        }
        if (input.operation === "synthesize") {
          if (!input.intendedClass || !input.figureHeight) throw new Error("synthesize requires intendedClass and figureHeight");
          const band = input.intendedClass === "walk" ? walkTargets(input.figureHeight) : runTargets(input.figureHeight);
          const params = gaitParameters(band, input.figureHeight);
          return response({ band: targetBandToJSON(band), parameters: params, clip: synthesiseGaitTracks(params) });
        }
        if (!input.payload) throw new Error(`${input.operation} requires payload`);
        const sourcePayload = loadClipPayload(input.payload);
        const payload = input.operation === "accept" && input.payload.authoredPayload !== undefined
          ? loadClipPayload(input.payload.authoredPayload)
          : sourcePayload;
        const clip = input.clipName
          ? payload.clips.find((candidate) => candidate.sourceName === input.clipName)
          : payload.clips[0];
        if (!clip) throw new Error(`clip ${JSON.stringify(input.clipName)} was not found in the sampled payload`);
        if (input.operation === "foot-slide") {
          if (!clip.stance) return failureWithReport("clip has no stance evidence", { status: "unevaluated" });
          return response(footSlide(clip.landmarkPositions, clip.sampleTimes, clip.stance, payload.figureHeight, input.limit));
        }
        if (!input.intendedClass) throw new Error("accept requires intendedClass");
        const band = input.intendedClass === "walk" ? walkTargets(payload.figureHeight) : runTargets(payload.figureHeight);
        const measured = bandFeatures(clip, payload.figureHeight);
        const features = measureClip(clip, payload.figureHeight);
        const classification = classify(features);
        const loop = decideLoop(features);
        const declaredLoop = clip.loop === undefined ? loop.loop : clip.loop;
        const acceptance = accepts(measured, band, input.intendedClass, {
          classifierInput: features,
          ...(clip.stance
            ? { footSlideResult: footSlide(clip.landmarkPositions, clip.sampleTimes, clip.stance, payload.figureHeight) }
            : {}),
          ...(declaredLoop === null || declaredLoop === undefined ? {} : { declaredLoop }),
          ...(payload.sourceScalesJoints === true ? { sourceScalesJoints: true } : {}),
          ...(payload.sourceRanges === undefined ? {} : { sourceRanges: payload.sourceRanges }),
          ...(payload.authoredRanges === undefined ? {} : { authoredRanges: payload.authoredRanges })
        });
        const sourceClip = input.clipName
          ? sourcePayload.clips.find((candidate) => candidate.sourceName === input.clipName)
          : sourcePayload.clips[0];
        const result = {
          clip: clip.sourceName,
          ...(sourceClip && sourceClip !== clip
            ? { sourceMeasured: measureClip(sourceClip, sourcePayload.figureHeight), authoredPayload: true }
            : {}),
          measured,
          classification,
          loop,
          acceptance
        };
        return acceptance.accepted && acceptance.complete ? response(result) : failureWithReport("action design acceptance did not pass", result);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "sculpt_rig_gate",
    {
      description:
        "Run every Stage R G1-G12 observation gate without short-circuiting; fail closed when any result is failed or unevaluated.",
      inputSchema: z
        .object({ payload: z.unknown() })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ payload }) => {
      try {
        const report = runGates(objectPayload(payload, "sculpt_rig_gate.payload"));
        return report.ok ? response(report.toJSON()) : response(report.toJSON(), true);
      } catch (error) {
        return failure(error);
      }
    }
  );

  return server;
}

export { PASS_ORDER } from "./constants.js";
export { gatePass } from "./gate.js";
export { loadGrimoireCatalog, resourceSafetyReason } from "./grimoire.js";
export { compareImages, inspectImage } from "./image.js";
export { ciede2000, deltaERgb, srgbToLab } from "./math/color-metrics.js";
export { gateObjectSculptSpec } from "./spec.js";
export {
  accepts,
  bandFeatures,
  checkMedialLateral,
  footSlide,
  gaitParameters,
  resolveChains,
  runTargets,
  synthesiseGaitTracks,
  targetBandToJSON,
  walkTargets
} from "./action-design.js";
export {
  BLEND_RADIUS,
  DISCARD_REPORT_THRESHOLD,
  MAX_INFLUENCES,
  RESIDUAL_NOTE,
  TRADE_NOTE,
  WEIGHT_SUM_TOLERANCE,
  SkinBinding,
  UniformGrid,
  blendWeights,
  bruteForceQuery,
  validateDiscardReport,
  validateBinding,
  weldCoincident
} from "./skin-conditioning.js";
export {
  FROZEN_ATTRIBUTES,
  FROZEN_BUFFERS,
  Manifest,
  ParityFailure,
  ParityReport,
  freeze as freezeMesh,
  hashBuffer,
  verify as verifyMesh
} from "./mesh-parity.js";
export {
  DEFAULT_SWEEP_COVERAGE,
  GATE_SPECS,
  GateReport,
  GateResult,
  runGates
} from "./rig-gates.js";
export {
  classify,
  decideLoop,
  loadClipPayload,
  measureClip,
  nameClip,
  report as reportClipFeatures
} from "./clip-features.js";
