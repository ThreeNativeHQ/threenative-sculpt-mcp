import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GRIMOIRE_ROOT = fileURLToPath(new URL("../grimoire/", import.meta.url));

export interface GrimoirePage {
  topic: string;
  uri: string;
  mimeType: string;
  text: string;
  sourcePath: string;
}

export interface RejectedGrimoirePage {
  topic: string;
  reason: string;
}

export interface GrimoireCatalog {
  pages: GrimoirePage[];
  rejected: RejectedGrimoirePage[];
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(fullPath) : [fullPath];
    })
  );
  return nested.flat();
}

export function resourceSafetyReason(text: string): string | null {
  if (/```(?:glsl|wgsl)\b/i.test(text)) {
    return "contains a concrete fenced shader recipe";
  }
  if (/^#{1,6}\s+.*material recipe/im.test(text)) {
    return "contains a concrete material recipe";
  }
  const fencedCode = text.match(/```(?:js|javascript|ts|typescript)[^\n]*\n[\s\S]*?```/gi) ?? [];
  if (
    fencedCode.some((block) =>
      /(?:new\s+)?(?:THREE\.)?(?:Mesh(?:Standard|Physical|Basic|Phong|Lambert|Toon)|Shader|Node)Material\b/.test(
        block
      )
    )
  ) {
    return "contains a concrete fenced Three.js material recipe";
  }
  return null;
}

export async function loadGrimoireCatalog(): Promise<GrimoireCatalog> {
  const files = (await walk(GRIMOIRE_ROOT))
    .filter((file) => [".md", ".json"].includes(path.extname(file)))
    .sort();
  const pages: GrimoirePage[] = [];
  const rejected: RejectedGrimoirePage[] = [];
  for (const sourcePath of files) {
    const extension = path.extname(sourcePath);
    const topic = path.relative(GRIMOIRE_ROOT, sourcePath).slice(0, -extension.length);
    const text = await readFile(sourcePath, "utf8");
    const reason = resourceSafetyReason(text);
    if (reason) {
      rejected.push({ topic, reason });
      continue;
    }
    pages.push({
      topic,
      uri: `sculpt://grimoire/${topic}`,
      mimeType: extension === ".json" ? "application/json" : "text/markdown",
      text,
      sourcePath
    });
  }
  return { pages, rejected };
}

export function findGrimoirePage(catalog: GrimoireCatalog, topic: string): GrimoirePage {
  const page = catalog.pages.find((candidate) => candidate.topic === topic);
  if (page) return page;
  const rejected = catalog.rejected.find((candidate) => candidate.topic === topic);
  const valid = catalog.pages.map((candidate) => candidate.topic).join(", ");
  if (rejected) {
    throw new Error(
      `grimoire topic "${topic}" is retained but cannot be served: ${rejected.reason}. Valid topics: ${valid}`
    );
  }
  throw new Error(`unknown grimoire topic "${topic}". Valid topics: ${valid}`);
}

