import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createSculptServer } from "../src/index.js";
import { DEFAULT_SIBLING_CHECKOUT, resolveSiblingCheckout } from "../scripts/verify-release.mts";

const expectedTools = [
  "sculpt_compare",
  "sculpt_grimoire",
  "sculpt_pass_gate",
  "sculpt_plan",
  "sculpt_spec_gate",
  "sculpt_clip_measure",
  "sculpt_rig_reference",
  "sculpt_rig_spec_gate",
  "sculpt_skin_condition",
  "sculpt_mesh_parity",
  "sculpt_action_design",
  "sculpt_rig_gate"
].sort();

describe("live MCP surface", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  async function connectedClient() {
    const server = await createSculptServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  async function referenceImage() {
    const directory = await mkdtemp(path.join(tmpdir(), "sculpt-mcp-"));
    const file = path.join(directory, "reference.png");
    const pixels = Buffer.alloc(16 * 16 * 3);
    for (let index = 0; index < pixels.length; index += 3) {
      pixels[index] = index % 251;
      pixels[index + 1] = (index * 3) % 251;
      pixels[index + 2] = (index * 7) % 251;
    }
    await sharp(pixels, { raw: { width: 16, height: 16, channels: 3 } }).png().toFile(file);
    return file;
  }

  it("lists exactly the twelve contracted tools", async () => {
    const client = await connectedClient();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(expectedTools);
  });

  it("lists safe resources but never the prohibited concrete shader page", async () => {
    const client = await connectedClient();
    const listed = await client.listResources();
    const uris = listed.resources.map((resource) => resource.uri);
    expect(uris).toContain("sculpt://grimoire/intake/quality_contract");
    expect(uris).not.toContain("sculpt://grimoire/character/structure_decomposition");
  });

  it("returns an MCP tool error naming a missing spec region for {}", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "sculpt_spec_gate", arguments: { spec: {} } });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text")?.text;
    const payload = JSON.parse(text ?? "{}") as { issues?: Array<{ region: string; message: string }> };
    expect(payload.issues).toContainEqual({
      region: "silhouette",
      message: 'missing required ObjectSculptSpec region "silhouette"'
    });
  });

  it("returns an MCP tool error for a prohibited retained page", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "sculpt_grimoire",
      arguments: { topic: "character/structure_decomposition" }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("retained but cannot be served");
  });

  it("runs the live plan and compare handlers with the eight-pass contract", async () => {
    const client = await connectedClient();
    const reference = await referenceImage();
    const plan = await client.callTool({
      name: "sculpt_plan",
      arguments: { referencePath: reference, intent: "bespoke character" }
    });
    expect(plan.isError).not.toBe(true);
    const planText = plan.content.find((item) => item.type === "text")?.text ?? "{}";
    const planPayload = JSON.parse(planText) as { passes: string[]; grimoireResources: string[] };
    expect(planPayload.passes).toHaveLength(8);
    expect(planPayload.passes.at(-1)).toBe("optimization-pass");
    expect(planPayload.grimoireResources).toContain(
      "sculpt://grimoire/character/reconstruction"
    );

    const comparison = await client.callTool({
      name: "sculpt_compare",
      arguments: { referencePath: reference, capturePath: reference }
    });
    expect(comparison.isError).not.toBe(true);
    const comparisonText = comparison.content.find((item) => item.type === "text")?.text ?? "{}";
    expect(JSON.parse(comparisonText)).toMatchObject({
      status: "evidence",
      authority: "diagnostic-only",
      overall: { score: 1 }
    });
  });

  it("routes an animated-character plan through the complete Stage R order", async () => {
    const client = await connectedClient();
    const reference = await referenceImage();
    const result = await client.callTool({
      name: "sculpt_plan",
      arguments: {
        referencePath: reference,
        intent: "animated character",
        profile: "animated-character"
      }
    });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
    const payload = JSON.parse(text) as {
      profile: string;
      stageR: Array<{ id: string }>;
      grimoireResources: string[];
    };
    expect(payload.profile).toBe("animated-character");
    expect(payload.stageR.map((step) => step.id)).toEqual([
      "rig-contract-read",
      "glb-rig-reference",
      "mesh-repair",
      "mesh-freeze",
      "rig-payload-validate",
      "rig-bind",
      "mesh-parity-verify",
      "clip-measure",
      "rig-gates"
    ]);
    expect(payload.grimoireResources).toContain(
      "sculpt://grimoire/readiness/animation_contract"
    );
  });

  it("rejects a skin result whose top-four loss exceeds the report threshold", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "sculpt_skin_condition",
      arguments: {
        figureHeight: 1,
        binding: {
          positions: [[0, 0, 0], [0.001, 0, 0], [0.0015, 0, 0], [0.002, 0, 0], [0.0025, 0, 0]],
          partIds: ["a", "b", "b", "b", "b"],
          skinIndices: [0, 1, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0],
          skinWeights: [0.7, 0.3, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
          jointCount: 6
        }
      }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("exceeding the allowed");
  });

  it("resolves the absolute sibling checkout and never uses the lane-relative candidate", () => {
    const engineLane = "/home/joao/projects/threenative/threenative-engine/.worktrees/prd-346-img2threejs-1-5-2-animation-proof";
    const resolution = resolveSiblingCheckout(engineLane, DEFAULT_SIBLING_CHECKOUT);
    expect(resolution.resolvedPath).toBe(DEFAULT_SIBLING_CHECKOUT);
    expect(existsSync(path.join(resolution.resolvedPath, "package.json"))).toBe(true);
    expect(resolution.laneRelativeCandidate).toBe(
      "/home/joao/projects/threenative/threenative-engine/.worktrees/threenative-sculpt-mcp"
    );
    expect(existsSync(resolution.laneRelativeCandidate)).toBe(false);
    expect(resolution.laneRelativeLookupUsed).toBe(false);
  });

  it("makes the live pass gate retry when semantic review is omitted", async () => {
    const client = await connectedClient();
    const reference = await referenceImage();
    const comparison = await client.callTool({
      name: "sculpt_compare",
      arguments: { referencePath: reference, capturePath: reference }
    });
    const comparisonText = comparison.content.find((item) => item.type === "text")?.text ?? "{}";
    const result = await client.callTool({
      name: "sculpt_pass_gate",
      arguments: { passId: "blockout", compareResult: JSON.parse(comparisonText) }
    });
    const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
    expect(JSON.parse(text)).toMatchObject({ decision: "retry", passId: "blockout" });
  });

  it("makes the live pass gate advance on strong semantics despite low diagnostics", async () => {
    const client = await connectedClient();
    const reference = await referenceImage();
    const comparison = await client.callTool({
      name: "sculpt_compare",
      arguments: { referencePath: reference, capturePath: reference }
    });
    const comparisonText = comparison.content.find((item) => item.type === "text")?.text ?? "{}";
    const compareResult = JSON.parse(comparisonText) as {
      overall: { score: number; confidence: number };
      regions: Array<{ score: number; confidence: number; corrections: string[] }>;
      ambiguous: boolean;
    };
    compareResult.overall = { score: 0.417777, confidence: 0.4 };
    compareResult.regions[0]!.score = 0.32;
    compareResult.regions[0]!.confidence = 0.35;
    compareResult.regions[0]!.corrections = ["recheck material response"];
    compareResult.ambiguous = false;
    const result = await client.callTool({
      name: "sculpt_pass_gate",
      arguments: {
        passId: "lighting-pass",
        compareResult,
        semanticReview: {
          score: 0.82,
          confidence: 0.86,
          notes: "Critical visual features match.",
          criticalFeatures: [
            { id: "silhouette", score: 0.84, threshold: 0.8, critical: true }
          ]
        }
      }
    });
    const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
    expect(JSON.parse(text)).toMatchObject({ decision: "advance", passId: "lighting-pass" });
  });
});
