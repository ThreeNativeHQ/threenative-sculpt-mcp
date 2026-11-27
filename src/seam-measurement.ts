import { BLEND_RADIUS, SkinBinding, type Vec3 } from "./skin-conditioning.js";

const WIDTH = 256;
const HEIGHT = 256;
const PIXEL_RADIUS = 2;
const PROJECTION_SCALE = 360;
const PIVOT: Vec3 = [0, -0.4, 0];
const CLIP_COUNT = 11;
const TIME_COUNT = 4;
const SIDE_COUNT = 2;
const AZIMUTH_COUNT = 2;
const SAMPLE_COUNT = CLIP_COUNT * TIME_COUNT * SIDE_COUNT * AZIMUTH_COUNT;

export interface SeamRasterCounts {
  backgroundThroughSplitPx: number;
  backgroundThroughSplitBlobs: number;
  creasePx: number;
}

export interface MultipartSeamMeasurement {
  schemaVersion: 1;
  method: string;
  dimensions: { width: number; height: number };
  frames: number;
  axes: { clips: number; times: number; sides: number; azimuths: number };
  source: SeamRasterCounts;
  conditioned: SeamRasterCounts;
}

interface PointMask {
  readonly byPart: Map<string, Uint8Array>;
  readonly points: Vec3[];
}

interface PairRegion {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

function rotate(point: Vec3, degrees: number): Vec3 {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point[0] - PIVOT[0];
  const y = point[1] - PIVOT[1];
  return [cosine * x - sine * y + PIVOT[0], sine * x + cosine * y + PIVOT[1], point[2]];
}

function pose(binding: SkinBinding, index: number, degrees: number): Vec3 {
  const point = binding.positions[index]!;
  return binding.influences(index).reduce<Vec3>(
    (result, [joint, weight]) => {
      if (weight === 0) return result;
      const moved = joint === 0 ? point : rotate(point, degrees);
      return [
        result[0] + weight * moved[0],
        result[1] + weight * moved[1],
        result[2] + weight * moved[2]
      ];
    },
    [0, 0, 0]
  );
}

function project(point: Vec3): [number, number] {
  return [
    Math.round(WIDTH / 2 + point[0] * PROJECTION_SCALE),
    Math.round(HEIGHT / 2 - point[1] * PROJECTION_SCALE)
  ];
}

function partMask(points: Vec3[], partIds: unknown[], part: string): Uint8Array {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  points.forEach((point, index) => {
    if (String(partIds[index]) !== part) return;
    const [centerX, centerY] = project(point);
    for (let y = centerY - PIXEL_RADIUS; y <= centerY + PIXEL_RADIUS; y += 1) {
      for (let x = centerX - PIXEL_RADIUS; x <= centerX + PIXEL_RADIUS; x += 1) {
        if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
        if ((x - centerX) ** 2 + (y - centerY) ** 2 > PIXEL_RADIUS ** 2) continue;
        mask[y * WIDTH + x] = 1;
      }
    }
  });
  return mask;
}

function masks(binding: SkinBinding, points: Vec3[]): PointMask {
  const parts = new Set(binding.partIds.map((part) => String(part)));
  return {
    byPart: new Map([...parts].map((part) => [part, partMask(points, binding.partIds, part)])),
    points
  };
}

function seamPairs(binding: SkinBinding): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let first = 0; first < binding.vertexCount; first += 1) {
    for (let second = first + 1; second < binding.vertexCount; second += 1) {
      if (String(binding.partIds[first]) === String(binding.partIds[second])) continue;
      const a = binding.positions[first]!;
      const b = binding.positions[second]!;
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= BLEND_RADIUS) pairs.push([first, second]);
    }
  }
  if (pairs.length === 0) throw new Error("multipart seam fixture has no cross-part vertices inside the blend radius");
  return pairs;
}

function region(points: Vec3[], pair: [number, number]): PairRegion {
  const projected = pair.map((index) => project(points[index]!));
  return {
    minX: Math.max(0, Math.min(...projected.map(([x]) => x)) - PIXEL_RADIUS - 1),
    maxX: Math.min(WIDTH - 1, Math.max(...projected.map(([x]) => x)) + PIXEL_RADIUS + 1),
    minY: Math.max(0, Math.min(...projected.map(([, y]) => y)) - PIXEL_RADIUS - 1),
    maxY: Math.min(HEIGHT - 1, Math.max(...projected.map(([, y]) => y)) + PIXEL_RADIUS + 1)
  };
}

function countBlobs(mask: Uint8Array, bounds: PairRegion): number {
  const visited = new Uint8Array(mask.length);
  let blobs = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const start = y * WIDTH + x;
      if (mask[start] !== 1 || visited[start] === 1) continue;
      blobs += 1;
      const queue: Array<[number, number]> = [[x, y]];
      visited[start] = 1;
      while (queue.length) {
        const [currentX, currentY] = queue.pop()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nextX = currentX + dx;
          const nextY = currentY + dy;
          if (nextX < bounds.minX || nextX > bounds.maxX || nextY < bounds.minY || nextY > bounds.maxY) continue;
          const next = nextY * WIDTH + nextX;
          if (mask[next] !== 1 || visited[next] === 1) continue;
          visited[next] = 1;
          queue.push([nextX, nextY]);
        }
      }
    }
  }
  return blobs;
}

function frameCounts(binding: SkinBinding, framePoints: Vec3[], comparisonPoints: Vec3[], pairs: Array<[number, number]>): SeamRasterCounts {
  const rendered = masks(binding, framePoints);
  const comparison = masks(binding, comparisonPoints);
  const holes = new Uint8Array(WIDTH * HEIGHT);
  const overlaps = new Uint8Array(WIDTH * HEIGHT);
  let backgroundThroughSplitPx = 0;
  let creasePx = 0;
  let backgroundThroughSplitBlobs = 0;
  for (const pair of pairs) {
    const firstPart = String(binding.partIds[pair[0]]);
    const secondPart = String(binding.partIds[pair[1]]);
    const first = rendered.byPart.get(firstPart)!;
    const second = rendered.byPart.get(secondPart)!;
    const firstComparison = comparison.byPart.get(firstPart)!;
    const secondComparison = comparison.byPart.get(secondPart)!;
    const bounds = region(comparisonPoints, pair);
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        const index = y * WIDTH + x;
        if (first[index] === 0 && second[index] === 0 && (firstComparison[index] === 1 || secondComparison[index] === 1)) {
          holes[index] = 1;
        }
        if (first[index] === 1 && second[index] === 1) {
          overlaps[index] = 1;
        }
      }
    }
  }
  for (const value of holes) backgroundThroughSplitPx += value;
  for (const value of overlaps) creasePx += value;
  backgroundThroughSplitBlobs = countBlobs(holes, { minX: 0, maxX: WIDTH - 1, minY: 0, maxY: HEIGHT - 1 });
  return { backgroundThroughSplitPx, backgroundThroughSplitBlobs, creasePx };
}

function addCounts(left: SeamRasterCounts, right: SeamRasterCounts): SeamRasterCounts {
  return {
    backgroundThroughSplitPx: left.backgroundThroughSplitPx + right.backgroundThroughSplitPx,
    backgroundThroughSplitBlobs: left.backgroundThroughSplitBlobs + right.backgroundThroughSplitBlobs,
    creasePx: left.creasePx + right.creasePx
  };
}

function angleForFrame(clip: number, time: number, side: number, azimuth: number): number {
  return (clip - (CLIP_COUNT - 1) / 2) * 3 + (time - (TIME_COUNT - 1) / 2) * 16 + (side === 0 ? -7 : 7) + (azimuth === 0 ? -4 : 4);
}

export function measureMultipartSeam(source: SkinBinding, conditioned: SkinBinding): MultipartSeamMeasurement {
  if (source.vertexCount !== conditioned.vertexCount) throw new Error("seam measurement needs source and conditioned bindings with equal vertex counts");
  const pairs = seamPairs(source);
  let sourceCounts: SeamRasterCounts = { backgroundThroughSplitPx: 0, backgroundThroughSplitBlobs: 0, creasePx: 0 };
  let conditionedCounts: SeamRasterCounts = { backgroundThroughSplitPx: 0, backgroundThroughSplitBlobs: 0, creasePx: 0 };
  for (let clip = 0; clip < CLIP_COUNT; clip += 1) {
    for (let time = 0; time < TIME_COUNT; time += 1) {
      for (let side = 0; side < SIDE_COUNT; side += 1) {
        for (let azimuth = 0; azimuth < AZIMUTH_COUNT; azimuth += 1) {
          const angle = angleForFrame(clip, time, side, azimuth);
          const sourcePoints = source.positions.map((_, index) => pose(source, index, angle));
          const conditionedPoints = conditioned.positions.map((_, index) => pose(conditioned, index, angle));
          sourceCounts = addCounts(sourceCounts, frameCounts(source, sourcePoints, conditionedPoints, pairs));
          conditionedCounts = addCounts(conditionedCounts, frameCounts(conditioned, conditionedPoints, sourcePoints, pairs));
        }
      }
    }
  }
  return {
    schemaVersion: 1,
    method: "deterministic 256x256 point-mask rasterization of every cross-part seam pair; four normalized poses x two sides x two azimuths for each of eleven fixture clips",
    dimensions: { width: WIDTH, height: HEIGHT },
    frames: SAMPLE_COUNT,
    axes: { clips: CLIP_COUNT, times: TIME_COUNT, sides: SIDE_COUNT, azimuths: AZIMUTH_COUNT },
    source: sourceCounts,
    conditioned: conditionedCounts
  };
}

export function formatSeamTrade(measurement: MultipartSeamMeasurement): string {
  const creaseChange = measurement.source.creasePx === 0
    ? "not computable from a zero source crease mask"
    : `${Math.round(((measurement.conditioned.creasePx / measurement.source.creasePx) - 1) * 100)}%`;
  return `Proximity blending closes holes while making the measured crease mask ${creaseChange} larger over ${measurement.frames} frames (${measurement.dimensions.width}x${measurement.dimensions.height} deterministic point-mask raster): holes ${measurement.source.backgroundThroughSplitPx}px/${measurement.source.backgroundThroughSplitBlobs} blobs -> ${measurement.conditioned.backgroundThroughSplitPx}px/${measurement.conditioned.backgroundThroughSplitBlobs} blobs; creases ${measurement.source.creasePx}px -> ${measurement.conditioned.creasePx}px. A hole shows the background, a crease shows skin; the trade was accepted deliberately.`;
}
