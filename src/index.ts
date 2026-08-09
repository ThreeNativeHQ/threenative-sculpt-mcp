import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { PASS_ORDER } from "./constants.js";
import { gatePass } from "./gate.js";
import { findGrimoirePage, loadGrimoireCatalog } from "./grimoire.js";
import { compareImages, inspectImage } from "./image.js";
import { gateObjectSculptSpec } from "./spec.js";

function response(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

function failure(error: unknown) {
  return response(
    { error: error instanceof Error ? error.message : String(error), failedClosed: true },
    true
  );
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

function relevantTopics(intent: string, validTopics: Set<string>): string[] {
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
  if (/character|creature|person|face|humanoid|animal/i.test(intent)) {
    topics.push(
      "character/reconstruction",
      "character/likeness_maximization",
      "character/head_construction",
      "readiness/joint_attachment",
      "readiness/action_rigging"
    );
  }
  return [...new Set(topics)].filter((topic) => validTopics.has(topic));
}

export async function createSculptServer(): Promise<McpServer> {
  const catalog = await loadGrimoireCatalog();
  const validTopics = new Set(catalog.pages.map((page) => page.topic));
  const server = new McpServer(
    { name: "threenative-sculpt-mcp", version: "0.1.0" },
    {
      instructions:
        "Use sculpt_plan, read its technique-safe grimoire resources, pass sculpt_spec_gate before writing code, then compare each playtest capture and call sculpt_pass_gate. Pixel metrics never replace semantic image review."
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
        intent: z.string().trim().min(1).max(500)
      }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ referencePath, intent }) => {
      try {
        const image = await inspectImage(referencePath, "reference");
        const topics = relevantTopics(intent, validTopics);
        if (topics.length === 0) throw new Error("no technique-safe grimoire topics are available");
        return response({
          reference: { path: referencePath, width: image.width, height: image.height },
          intent,
          passes: PASS_ORDER,
          grimoireResources: topics.map((topic) => `sculpt://grimoire/${topic}`),
          contract: "write and gate ObjectSculptSpec before authoring src/render source"
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "sculpt_spec_gate",
    {
      description:
        "Validate the MCP runtime ObjectSculptSpec contract and canonical complexity depth thresholds before code is written.",
      inputSchema: z.object({ spec: z.record(z.string(), z.unknown()) }),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ spec }) => {
      const result = gateObjectSculptSpec(spec);
      return result.valid ? response(result) : response(result, true);
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
        "Return advance, retry, or stop from deterministic diagnostics plus semantic critical-feature review. Missing or ambiguous evidence always retries or stops.",
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

  return server;
}

export { PASS_ORDER } from "./constants.js";
export { gatePass } from "./gate.js";
export { loadGrimoireCatalog, resourceSafetyReason } from "./grimoire.js";
export { compareImages, inspectImage } from "./image.js";
export { ciede2000, deltaERgb, srgbToLab } from "./math/color-metrics.js";
export { gateObjectSculptSpec } from "./spec.js";
