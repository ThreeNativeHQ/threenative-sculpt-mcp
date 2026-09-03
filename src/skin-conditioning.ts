export const BLEND_RADIUS = 0.006;
export const WEIGHT_SUM_TOLERANCE = 2e-7;
export const MAX_INFLUENCES = 4;
export const WELD_TOLERANCE = 1e-4;
export const DISCARD_REPORT_THRESHOLD = 1e-3;

export const TRADE_NOTE =
  "Proximity blending closes holes and makes creases ~16% worse (measured over 176 frames: holes 974px/30 blobs -> 287px/15 blobs, creases 31,316px -> 36,470px). A hole shows the background, a crease shows skin; the trade was accepted deliberately. Do not disable the blend to bring the crease count back down.";
export const RESIDUAL_NOTE =
  "Creases are not eliminated by this method. Removing them entirely needs one continuous mesh with a unified weight field, which changes the part structure and breaks per-part UI.";

export type Vec3 = [number, number, number];

export interface SkinBindingInput {
  positions: Vec3[];
  partIds: unknown[];
  skinIndices: number[];
  skinWeights: number[];
  jointCount: number;
}

export class SkinBinding {
  readonly positions: Vec3[];
  readonly partIds: unknown[];
  readonly skinIndices: number[];
  readonly skinWeights: number[];
  readonly jointCount: number;

  constructor(input: SkinBindingInput);
  constructor(
    positions: Vec3[],
    partIds: unknown[],
    skinIndices: number[],
    skinWeights: number[],
    jointCount: number
  );
  constructor(
    first: SkinBindingInput | Vec3[],
    second?: unknown[],
    third?: number[],
    fourth?: number[],
    fifth?: number
  ) {
    const input: SkinBindingInput = Array.isArray(first)
      ? {
          positions: first,
          partIds: second ?? [],
          skinIndices: third ?? [],
          skinWeights: fourth ?? [],
          jointCount: fifth ?? 0
        }
      : first;
    this.positions = input.positions.map((point) => [...point] as Vec3);
    this.partIds = [...input.partIds];
    this.skinIndices = [...input.skinIndices];
    this.skinWeights = [...input.skinWeights];
    this.jointCount = input.jointCount;
  }

  get vertexCount(): number {
    return this.positions.length;
  }

  influences(index: number): Array<[number, number]> {
    if (!Number.isInteger(index) || index < 0 || index >= this.vertexCount) {
      throw new RangeError(`vertex index ${index} is outside [0, ${this.vertexCount - 1}]`);
    }
    const base = index * MAX_INFLUENCES;
    return Array.from({ length: MAX_INFLUENCES }, (_, slot) => [
      this.skinIndices[base + slot] as number,
      this.skinWeights[base + slot] as number
    ]);
  }

  toJSON(): SkinBindingInput {
    return {
      positions: this.positions.map((point) => [...point] as Vec3),
      partIds: [...this.partIds],
      skinIndices: [...this.skinIndices],
      skinWeights: [...this.skinWeights],
      jointCount: this.jointCount
    };
  }

  static fromJSON(value: unknown): SkinBinding {
    if (!isRecord(value)) throw new Error("binding payload must be an object");
    const allowed = new Set(["positions", "partIds", "skinIndices", "skinWeights", "jointCount"]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Error(`binding payload has unknown field '${key}'`);
    }
    const positions = value.positions;
    const partIds = value.partIds;
    const skinIndices = value.skinIndices;
    const skinWeights = value.skinWeights;
    const jointCount = value.jointCount;
    if (!Array.isArray(positions)) throw new Error("binding payload is missing 'positions'");
    if (!Array.isArray(partIds)) throw new Error("binding payload is missing 'partIds'");
    if (!Array.isArray(skinIndices)) throw new Error("binding payload is missing 'skinIndices'");
    if (!Array.isArray(skinWeights)) throw new Error("binding payload is missing 'skinWeights'");
    if (!finite(jointCount)) throw new Error("binding payload is missing finite 'jointCount'");
    return new SkinBinding({
      positions: positions.map((point, index) => vector3(point, `positions[${index}]`)),
      partIds: [...partIds],
      skinIndices: skinIndices.map((item, index) => numberValue(item, `skinIndices[${index}]`)),
      skinWeights: skinWeights.map((item, index) => numberValue(item, `skinWeights[${index}]`)),
      jointCount
    });
  }
}

export interface BlendReportValue {
  verticesTotal: number;
  verticesTouched: number;
  verticesInterior: number;
  verticesWithoutWeight: number;
  figureHeight: number;
  radiusFraction: number;
  radiusWorld: number;
  maxInfluencesSeen: number;
  lossyReductions: number;
  maxDiscardedFraction: number;
  discardThreshold: number;
  trade: string;
  residual: string;
}

export class BlendReport implements BlendReportValue {
  readonly verticesTotal: number;
  readonly verticesTouched: number;
  readonly verticesInterior: number;
  readonly verticesWithoutWeight: number;
  readonly figureHeight: number;
  readonly radiusFraction: number;
  readonly radiusWorld: number;
  readonly maxInfluencesSeen: number;
  readonly lossyReductions: number;
  readonly maxDiscardedFraction: number;
  readonly discardThreshold = DISCARD_REPORT_THRESHOLD;
  readonly trade = TRADE_NOTE;
  readonly residual = RESIDUAL_NOTE;

  constructor(input: Omit<BlendReportValue, "discardThreshold" | "trade" | "residual">) {
    this.verticesTotal = input.verticesTotal;
    this.verticesTouched = input.verticesTouched;
    this.verticesInterior = input.verticesInterior;
    this.verticesWithoutWeight = input.verticesWithoutWeight;
    this.figureHeight = input.figureHeight;
    this.radiusFraction = input.radiusFraction;
    this.radiusWorld = input.radiusWorld;
    this.maxInfluencesSeen = input.maxInfluencesSeen;
    this.lossyReductions = input.lossyReductions;
    this.maxDiscardedFraction = input.maxDiscardedFraction;
  }

  toJSON(): BlendReportValue {
    return {
      verticesTotal: this.verticesTotal,
      verticesTouched: this.verticesTouched,
      verticesInterior: this.verticesInterior,
      verticesWithoutWeight: this.verticesWithoutWeight,
      figureHeight: this.figureHeight,
      radiusFraction: this.radiusFraction,
      radiusWorld: this.radiusWorld,
      maxInfluencesSeen: this.maxInfluencesSeen,
      lossyReductions: this.lossyReductions,
      maxDiscardedFraction: this.maxDiscardedFraction,
      discardThreshold: this.discardThreshold,
      trade: this.trade,
      residual: this.residual
    };
  }
}

export interface BlendResult {
  binding: SkinBinding;
  report: BlendReport;
}

export interface Neighbor {
  index: number;
  distance: number;
}

export const CELL_OFFSETS: ReadonlyArray<[number, number, number]> = Array.from(
  [-1, 0, 1],
  (dx) =>
    Array.from([-1, 0, 1], (dy) =>
      Array.from([-1, 0, 1], (dz) => [dx, dy, dz] as [number, number, number])
    )
).flat(2) as Array<[number, number, number]>;

export class UniformGrid {
  readonly cellSize: number;
  readonly buckets = new Map<string, number[]>();
  readonly positions: Vec3[];
  bucketsVisited = 0;
  maxBucketsPerQuery = 0;

  constructor(positions: Vec3[], cellSize: number) {
    if (!(cellSize > 0)) throw new Error("cell_size must be positive");
    this.positions = positions;
    this.cellSize = cellSize;
    positions.forEach((point, index) => {
      const key = this.key(this.cellOf(point));
      const bucket = this.buckets.get(key) ?? [];
      bucket.push(index);
      this.buckets.set(key, bucket);
    });
  }

  cellOf(point: Vec3): [number, number, number] {
    return [
      Math.floor(point[0] / this.cellSize),
      Math.floor(point[1] / this.cellSize),
      Math.floor(point[2] / this.cellSize)
    ];
  }

  query(point: Vec3, radius: number): Neighbor[] {
    if (radius > this.cellSize) {
      throw new Error(
        `radius ${radius} exceeds cell size ${this.cellSize}; the 27-bucket walk would miss neighbours`
      );
    }
    const [x, y, z] = this.cellOf(point);
    const found: Neighbor[] = [];
    let visited = 0;
    for (const [dx, dy, dz] of CELL_OFFSETS) {
      visited += 1;
      for (const index of this.buckets.get(this.key([x + dx, y + dy, z + dz])) ?? []) {
        const other = this.positions[index]!;
        const distance = Math.hypot(
          point[0] - other[0],
          point[1] - other[1],
          point[2] - other[2]
        );
        if (distance <= radius) found.push({ index, distance });
      }
    }
    this.bucketsVisited += visited;
    this.maxBucketsPerQuery = Math.max(this.maxBucketsPerQuery, visited);
    return found;
  }

  private key(cell: [number, number, number]): string {
    return cell.join(",");
  }
}

export function bruteForceQuery(positions: Vec3[], point: Vec3, radius: number): Neighbor[] {
  return positions.flatMap((other, index) => {
    const distance = Math.hypot(
      point[0] - other[0],
      point[1] - other[1],
      point[2] - other[2]
    );
    return distance <= radius ? [{ index, distance }] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberValue(value: unknown, label: string): number {
  if (!finite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function vector3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) {
    throw new Error(`${label} must be a finite [x, y, z]`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function checkShape(binding: SkinBinding): void {
  const count = binding.vertexCount;
  if (count === 0) throw new Error("binding has no vertices");
  if (binding.positions.some((point, index) => point.length !== 3 || !point.every(finite))) {
    throw new Error("positions must contain finite length-3 vectors");
  }
  if (binding.partIds.length !== count) {
    throw new Error(`partIds has ${binding.partIds.length} entries for ${count} vertices; one per vertex`);
  }
  if (binding.skinIndices.length !== count * MAX_INFLUENCES) {
    throw new Error(`skinIndices has ${binding.skinIndices.length} entries; expected ${count * MAX_INFLUENCES}`);
  }
  if (binding.skinWeights.length !== count * MAX_INFLUENCES) {
    throw new Error(`skinWeights has ${binding.skinWeights.length} entries; expected ${count * MAX_INFLUENCES}`);
  }
  if (!Number.isInteger(binding.jointCount) || binding.jointCount < 1) {
    throw new Error("jointCount must be an integer of at least 1");
  }
}

function stableSum(values: number[]): number {
  const ordered = [...values].sort((a, b) => Math.abs(a) - Math.abs(b));
  let sum = 0;
  let correction = 0;
  for (const value of ordered) {
    const corrected = value - correction;
    const next = sum + corrected;
    correction = next - sum - corrected;
    sum = next;
  }
  return sum;
}

function denseField(binding: SkinBinding, neighbours: Neighbor[], radius: number): Map<number, number> {
  const terms = new Map<number, number[]>();
  for (const { index, distance } of neighbours) {
    const kernel = (1 - distance / radius) ** 2;
    const base = index * MAX_INFLUENCES;
    for (let slot = 0; slot < MAX_INFLUENCES; slot += 1) {
      const weight = binding.skinWeights[base + slot]!;
      if (!(weight > 0)) continue;
      const joint = binding.skinIndices[base + slot]!;
      const values = terms.get(joint) ?? [];
      values.push(weight * kernel);
      terms.set(joint, values);
    }
  }
  return new Map([...terms].map(([joint, values]) => [joint, stableSum(values)]));
}

function reduceField(field: Map<number, number>): {
  indices: number[];
  weights: number[];
  discarded: number;
} {
  const ordered = [...field.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const kept = ordered.slice(0, MAX_INFLUENCES);
  const total = stableSum([...field.values()]);
  const keptTotal = stableSum(kept.map(([, weight]) => weight));
  if (!(keptTotal > 0)) {
    return { indices: Array(MAX_INFLUENCES).fill(0), weights: Array(MAX_INFLUENCES).fill(0), discarded: 0 };
  }
  const indices = Array(MAX_INFLUENCES).fill(0);
  const weights = Array(MAX_INFLUENCES).fill(0);
  kept.forEach(([joint, weight], slot) => {
    indices[slot] = joint;
    weights[slot] = weight / keptTotal;
  });
  weights[0] = (weights[0] ?? 0) + 1 - stableSum(weights);
  return {
    indices,
    weights,
    discarded: total > 0 ? (total - keptTotal) / total : 0
  };
}

export function blendWeights(
  source: SkinBinding | SkinBindingInput,
  figureHeight: number,
  radius = BLEND_RADIUS
): BlendResult {
  const binding = source instanceof SkinBinding ? source : new SkinBinding(source);
  checkShape(binding);
  if (!(figureHeight > 0) || !Number.isFinite(figureHeight)) throw new Error("figureHeight must be positive");
  if (!(radius > 0) || !Number.isFinite(radius)) throw new Error("radius must be positive");
  const radiusWorld = radius * figureHeight;
  const grid = new UniformGrid(binding.positions, radiusWorld);
  const pending = new Map<number, { indices: number[]; weights: number[] }>();
  let touched = 0;
  let interior = 0;
  let withoutWeight = 0;
  let maxInfluencesSeen = 0;
  let lossy = 0;
  let maxDiscarded = 0;
  for (let index = 0; index < binding.vertexCount; index += 1) {
    const neighbours = grid.query(binding.positions[index]!, radiusWorld);
    const ownPart = binding.partIds[index];
    if (!neighbours.some(({ index: other }) => binding.partIds[other] !== ownPart)) {
      interior += 1;
      continue;
    }
    const field = denseField(binding, neighbours, radiusWorld);
    maxInfluencesSeen = Math.max(maxInfluencesSeen, field.size);
    if (field.size === 0 || !(stableSum([...field.values()]) > 0)) {
      withoutWeight += 1;
      continue;
    }
    const reduced = reduceField(field);
    maxDiscarded = Math.max(maxDiscarded, reduced.discarded);
    if (reduced.discarded > DISCARD_REPORT_THRESHOLD) lossy += 1;
    pending.set(index, { indices: reduced.indices, weights: reduced.weights });
    touched += 1;
  }
  const indices: number[] = [];
  const weights: number[] = [];
  for (let index = 0; index < binding.vertexCount; index += 1) {
    const result = pending.get(index);
    const base = index * MAX_INFLUENCES;
    indices.push(...(result?.indices ?? binding.skinIndices.slice(base, base + MAX_INFLUENCES)));
    weights.push(...(result?.weights ?? binding.skinWeights.slice(base, base + MAX_INFLUENCES)));
  }
  return {
    binding: new SkinBinding({
      positions: binding.positions,
      partIds: binding.partIds,
      skinIndices: indices,
      skinWeights: weights,
      jointCount: binding.jointCount
    }),
    report: new BlendReport({
      verticesTotal: binding.vertexCount,
      verticesTouched: touched,
      verticesInterior: interior,
      verticesWithoutWeight: withoutWeight,
      figureHeight,
      radiusFraction: radius,
      radiusWorld,
      maxInfluencesSeen,
      lossyReductions: lossy,
      maxDiscardedFraction: maxDiscarded
    })
  };
}

export function weldCoincident(
  source: SkinBinding | SkinBindingInput,
  figureHeight: number,
  tolerance = WELD_TOLERANCE
): { binding: SkinBinding; weldedGroups: number } {
  const binding = source instanceof SkinBinding ? source : new SkinBinding(source);
  checkShape(binding);
  if (!(figureHeight > 0)) throw new Error("figureHeight must be positive");
  const worldTolerance = tolerance * figureHeight;
  const grid = new UniformGrid(binding.positions, worldTolerance);
  const parent = Array.from({ length: binding.vertexCount }, (_, index) => index);
  const find = (node: number): number => {
    let current = node;
    while (parent[current] !== current) {
      const next = parent[current];
      if (next === undefined) throw new Error(`union-find parent ${current} is missing`);
      parent[current] = parent[next]!;
      current = parent[current]!;
    }
    return current;
  };
  for (let index = 0; index < binding.vertexCount; index += 1) {
    for (const { index: other } of grid.query(binding.positions[index]!, worldTolerance)) {
      const a = find(index);
      const b = find(other);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < binding.vertexCount; index += 1) {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  }
  const pending = new Map<number, { indices: number[]; weights: number[] }>();
  let weldedGroups = 0;
  for (const members of groups.values()) {
    if (members.length < 2 || new Set(members.map((index) => binding.partIds[index])).size < 2) continue;
    weldedGroups += 1;
    const reduced = reduceField(denseField(binding, members.map((index) => ({ index, distance: 0 })), worldTolerance));
    for (const index of members) pending.set(index, { indices: reduced.indices, weights: reduced.weights });
  }
  const indices: number[] = [];
  const weights: number[] = [];
  for (let index = 0; index < binding.vertexCount; index += 1) {
    const result = pending.get(index);
    const base = index * MAX_INFLUENCES;
    indices.push(...(result?.indices ?? binding.skinIndices.slice(base, base + MAX_INFLUENCES)));
    weights.push(...(result?.weights ?? binding.skinWeights.slice(base, base + MAX_INFLUENCES)));
  }
  return {
    binding: new SkinBinding({ positions: binding.positions, partIds: binding.partIds, skinIndices: indices, skinWeights: weights, jointCount: binding.jointCount }),
    weldedGroups
  };
}

export function validateBinding(source: SkinBinding | SkinBindingInput): string[] {
  const binding = source instanceof SkinBinding ? source : new SkinBinding(source);
  const failures: string[] = [];
  const count = binding.vertexCount;
  if (count === 0) return ["binding has no vertices"];
  if (binding.partIds.length !== count) failures.push(`partIds has ${binding.partIds.length} entries for ${count} vertices; expected one each`);
  if (binding.skinIndices.length !== count * MAX_INFLUENCES) failures.push(`skinIndices has ${binding.skinIndices.length} entries; expected ${count * MAX_INFLUENCES}`);
  if (binding.skinWeights.length !== count * MAX_INFLUENCES) failures.push(`skinWeights has ${binding.skinWeights.length} entries; expected ${count * MAX_INFLUENCES}`);
  if (!Number.isInteger(binding.jointCount) || binding.jointCount < 1) failures.push(`jointCount is ${binding.jointCount}; expected at least 1`);
  if (failures.length) return failures;
  let sumFailures = 0;
  let rangeFailures = 0;
  let worstSumError = 0;
  let maxIndex = 0;
  for (let index = 0; index < count; index += 1) {
    const base = index * MAX_INFLUENCES;
    const weights = binding.skinWeights.slice(base, base + MAX_INFLUENCES);
    const error = Math.abs(1 - stableSum(weights));
    if (!(error <= WEIGHT_SUM_TOLERANCE)) {
      sumFailures += 1;
      worstSumError = Math.max(worstSumError, Number.isNaN(error) ? Number.POSITIVE_INFINITY : error);
      if (failures.length < 20) failures.push(`vertex ${index}: |1 - sum(w)| = ${error.toExponential(3)} exceeds ${WEIGHT_SUM_TOLERANCE.toExponential(1)} (weights ${JSON.stringify(weights)})`);
    }
    for (let slot = 0; slot < MAX_INFLUENCES; slot += 1) {
      const joint = binding.skinIndices[base + slot]!;
      maxIndex = Math.max(maxIndex, joint);
      if (!Number.isInteger(joint) || joint < 0 || joint > binding.jointCount - 1) {
        rangeFailures += 1;
        if (failures.length < 20) failures.push(`vertex ${index} slot ${slot}: skin index ${joint} outside [0, ${binding.jointCount - 1}]`);
      }
    }
  }
  if (sumFailures + rangeFailures > failures.length) {
    failures.push(`... ${sumFailures} weight-sum failures (worst ${worstSumError.toExponential(3)}) and ${rangeFailures} index-range failures in total; maxSkinIndex = ${maxIndex}, jointCount = ${binding.jointCount}`);
  }
  return failures;
}

export const blend_weights = blendWeights;
export const validate_binding = validateBinding;
export const weld_coincident = weldCoincident;
export const brute_force_query = bruteForceQuery;
