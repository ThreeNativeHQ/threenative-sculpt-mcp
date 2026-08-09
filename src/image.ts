import { access, stat } from "node:fs/promises";
import sharp from "sharp";
import { deltaERgb, type Rgb } from "./math/color-metrics.js";
import { normalizedHashSimilarity, perceptualHash } from "./math/image-hash.js";
import { structuralSimilarity } from "./math/ssim.js";

const SAMPLE_SIZE = 64;

export interface CompareRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionComparison {
  id: string;
  pixels: number;
  score: number;
  confidence: number;
  signals: {
    structuralSimilarity: number;
    perceptualHashSimilarity: number;
    colorSimilarity: number;
    deltaE00: number;
  };
  corrections: string[];
}

export interface SculptCompareResult {
  status: "evidence";
  authority: "diagnostic-only";
  referencePath: string;
  capturePath: string;
  dimensions: {
    reference: { width: number; height: number };
    capture: { width: number; height: number };
    normalizedForComparison: { width: number; height: number };
  };
  overall: { score: number; confidence: number };
  regions: RegionComparison[];
  ambiguous: boolean;
  notes: string[];
}

interface LoadedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

async function assertFile(path: string, label: string): Promise<void> {
  if (!path.trim()) throw new Error(`${label} path must not be empty`);
  try {
    await access(path);
  } catch {
    throw new Error(`${label} image does not exist or is unreadable: ${path}`);
  }
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`${label} image path is not a file: ${path}`);
  if (file.size === 0) throw new Error(`${label} image is zero bytes: ${path}`);
}

export async function inspectImage(path: string, label: string): Promise<{
  width: number;
  height: number;
  uniform: boolean;
}> {
  await assertFile(path, label);
  try {
    const pipeline = sharp(path, { failOn: "error" });
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("decoded image has no positive dimensions");
    }
    const stats = await pipeline.stats();
    const colorChannels = stats.channels.slice(0, 3);
    return {
      width: metadata.width,
      height: metadata.height,
      uniform:
        colorChannels.length === 3 &&
        colorChannels.every((channel) => channel.min === channel.max)
    };
  } catch (error) {
    throw new Error(
      `${label} image cannot be decoded: ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function loadNormalized(path: string): Promise<LoadedImage> {
  const { data, info } = await sharp(path, { failOn: "error" })
    .removeAlpha()
    .toColourspace("srgb")
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: new Uint8Array(data) };
}

function regionBounds(region: CompareRegion, image: LoadedImage) {
  const left = Math.floor(region.x * image.width);
  const top = Math.floor(region.y * image.height);
  const right = Math.ceil((region.x + region.width) * image.width);
  const bottom = Math.ceil((region.y + region.height) * image.height);
  return {
    left: Math.max(0, Math.min(image.width - 1, left)),
    top: Math.max(0, Math.min(image.height - 1, top)),
    right: Math.max(1, Math.min(image.width, right)),
    bottom: Math.max(1, Math.min(image.height, bottom))
  };
}

function lumaAndColor(image: LoadedImage, region: CompareRegion) {
  const bounds = regionBounds(region, image);
  const luma: number[] = [];
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const offset = (y * image.width + x) * 3;
      const r = image.pixels[offset]!;
      const g = image.pixels[offset + 1]!;
      const b = image.pixels[offset + 2]!;
      luma.push((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
      red += r;
      green += g;
      blue += b;
    }
  }
  const count = luma.length;
  const color: Rgb = [red / count, green / count, blue / count];
  return { luma, color, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
}

function squareDownsample(values: readonly number[], width: number, height: number, size = 32) {
  const sums = Array.from({ length: size * size }, () => 0);
  const counts = Array.from({ length: size * size }, () => 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetX = Math.min(size - 1, Math.floor((x * size) / width));
      const targetY = Math.min(size - 1, Math.floor((y * size) / height));
      const target = targetY * size + targetX;
      sums[target] = sums[target]! + values[y * width + x]! * 255;
      counts[target] = counts[target]! + 1;
    }
  }
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const index = y * size + x;
      return counts[index]! > 0 ? sums[index]! / counts[index]! : 0;
    })
  );
}

function correctionsFor(signals: RegionComparison["signals"]): string[] {
  const corrections: string[] = [];
  if (signals.structuralSimilarity < 0.7) {
    corrections.push("recheck silhouette, camera alignment, and primary proportions");
  }
  if (signals.perceptualHashSimilarity < 0.7) {
    corrections.push("recheck component placement and large-scale structure");
  }
  if (signals.colorSimilarity < 0.7) {
    corrections.push("recheck reference-derived material colour and lighting response");
  }
  return corrections.length > 0 ? corrections : ["request semantic review of critical features"];
}

function compareRegion(
  reference: LoadedImage,
  capture: LoadedImage,
  region: CompareRegion
): RegionComparison {
  const first = lumaAndColor(reference, region);
  const second = lumaAndColor(capture, region);
  const ssim = structuralSimilarity(first.luma, second.luma);
  const firstHash = perceptualHash(squareDownsample(first.luma, first.width, first.height));
  const secondHash = perceptualHash(squareDownsample(second.luma, second.width, second.height));
  const hashSimilarity = normalizedHashSimilarity(firstHash, secondHash);
  const deltaE = deltaERgb(first.color, second.color);
  const colorSimilarity = Math.exp(-deltaE / 20);
  const pixels = first.luma.length;
  const confidence = Math.min(1, Math.sqrt(pixels) / 32);
  const signals = {
    structuralSimilarity: rounded(ssim),
    perceptualHashSimilarity: rounded(hashSimilarity),
    colorSimilarity: rounded(colorSimilarity),
    deltaE00: rounded(deltaE)
  };
  return {
    id: region.id,
    pixels,
    score: rounded(ssim * 0.5 + hashSimilarity * 0.3 + colorSimilarity * 0.2),
    confidence: rounded(confidence),
    signals,
    corrections: correctionsFor(signals)
  };
}

export async function compareImages(
  referencePath: string,
  capturePath: string,
  regions: CompareRegion[]
): Promise<SculptCompareResult> {
  const referenceInfo = await inspectImage(referencePath, "reference");
  const captureInfo = await inspectImage(capturePath, "capture");
  if (captureInfo.uniform) {
    throw new Error(`capture image is all one colour; comparison cannot run: ${capturePath}`);
  }
  if (referenceInfo.uniform) {
    throw new Error(`reference image is all one colour; comparison cannot run: ${referencePath}`);
  }
  const normalizedRegions =
    regions.length > 0 ? regions : [{ id: "full", x: 0, y: 0, width: 1, height: 1 }];
  const reference = await loadNormalized(referencePath);
  const capture = await loadNormalized(capturePath);
  const results = normalizedRegions.map((region) => compareRegion(reference, capture, region));
  const overallScore = results.reduce((sum, region) => sum + region.score, 0) / results.length;
  const overallConfidence =
    results.reduce((sum, region) => sum + region.confidence, 0) / results.length;
  const dimensionsMatch =
    referenceInfo.width === captureInfo.width && referenceInfo.height === captureInfo.height;
  const confidence = overallConfidence * (dimensionsMatch ? 1 : 0.85);
  return {
    status: "evidence",
    authority: "diagnostic-only",
    referencePath,
    capturePath,
    dimensions: {
      reference: { width: referenceInfo.width, height: referenceInfo.height },
      capture: { width: captureInfo.width, height: captureInfo.height },
      normalizedForComparison: { width: SAMPLE_SIZE, height: SAMPLE_SIZE }
    },
    overall: { score: rounded(overallScore), confidence: rounded(confidence) },
    regions: results,
    ambiguous: confidence < 0.65,
    notes: [
      "Deterministic pixel metrics are diagnostic evidence, not advancement authority.",
      ...(dimensionsMatch ? [] : ["Capture was resized to the reference comparison grid."])
    ]
  };
}
