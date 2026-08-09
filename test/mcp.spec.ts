import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createSculptServer } from "../src/index.js";

const expectedTools = [
  "sculpt_compare",
  "sculpt_grimoire",
  "sculpt_pass_gate",
  "sculpt_plan",
  "sculpt_spec_gate"
];

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

  it("lists exactly the five contracted tools", async () => {
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
});
