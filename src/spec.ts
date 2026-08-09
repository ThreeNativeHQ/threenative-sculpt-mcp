import {
  COMPLEXITY_THRESHOLDS,
  type ComplexityTier
} from "./constants.js";

export interface SpecGateIssue {
  region: string;
  message: string;
}

export interface SpecGateResult {
  valid: boolean;
  tier: ComplexityTier | null;
  actualDepth: Record<string, number>;
  requiredDepth: Record<string, number> | null;
  issues: SpecGateIssue[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function missing(issues: SpecGateIssue[], region: string): void {
  issues.push({
    region,
    message: `missing required ObjectSculptSpec region "${region}"`
  });
}

const REQUIRED_REGIONS = [
  "targetName",
  "suitability",
  "coordinateFrame",
  "silhouette",
  "componentTree",
  "materials",
  "proceduralStrategy",
  "preSpecAssessment",
  "qualityContract",
  "qualityTargets"
] as const;

export function gateObjectSculptSpec(value: unknown): SpecGateResult {
  const issues: SpecGateIssue[] = [];
  const spec = object(value);
  if (!spec) {
    return {
      valid: false,
      tier: null,
      actualDepth: {},
      requiredDepth: null,
      issues: [{ region: "$", message: "ObjectSculptSpec must be a JSON object" }]
    };
  }
  for (const region of REQUIRED_REGIONS) {
    if (!(region in spec)) missing(issues, region);
  }
  if ("targetName" in spec && !nonEmptyString(spec.targetName)) {
    issues.push({ region: "targetName", message: "targetName must be a non-empty string" });
  }
  if (
    "suitability" in spec &&
    !["pass", "conditional", "reject"].includes(String(spec.suitability))
  ) {
    issues.push({ region: "suitability", message: "suitability must be pass, conditional, or reject" });
  }
  for (const region of ["coordinateFrame", "silhouette"] as const) {
    if (region in spec && !object(spec[region])) {
      issues.push({ region, message: `${region} must be an object` });
    }
  }
  const components = array(spec.componentTree).filter((item) => object(item)) as Record<
    string,
    unknown
  >[];
  const materials = array(spec.materials).filter((item) => object(item));
  const repetitions = array(spec.repetitionSystems).filter((item) => object(item));
  const strategy = array(spec.proceduralStrategy);
  if ("componentTree" in spec && components.length === 0) {
    issues.push({ region: "componentTree", message: "componentTree must contain components" });
  }
  if ("materials" in spec && materials.length === 0) {
    issues.push({ region: "materials", message: "materials must contain material records" });
  }
  if (
    "proceduralStrategy" in spec &&
    (strategy.length === 0 || strategy.some((item) => !nonEmptyString(item)))
  ) {
    issues.push({
      region: "proceduralStrategy",
      message: "proceduralStrategy must contain non-empty steps"
    });
  }
  const assessment = object(spec.preSpecAssessment);
  const complexity = object(assessment?.complexity);
  const candidateTier = complexity?.tier;
  const tier =
    typeof candidateTier === "string" && candidateTier in COMPLEXITY_THRESHOLDS
      ? (candidateTier as ComplexityTier)
      : null;
  if (assessment && !tier) {
    issues.push({
      region: "preSpecAssessment.complexity.tier",
      message: "complexity tier must be simple, moderate, complex, or ultra-complex"
    });
  }
  const inventory = object(assessment?.detailInventory);
  const details = array(inventory?.details);
  const contract = object(spec.qualityContract);
  const declaredMinimums = object(contract?.minimumSpecDepth);
  if (contract && !declaredMinimums) {
    missing(issues, "qualityContract.minimumSpecDepth");
  }
  const targets = object(spec.qualityTargets);
  const viewpoints = array(targets?.reviewViewpoints);
  const actualDepth = {
    macroComponents: components.filter((item) => item.level === "macro").length,
    mesoComponents: components.filter((item) => item.level === "meso").length,
    microFeatureGroups: components.reduce(
      (count, item) => count + array(item.localFeatures).length,
      0
    ),
    materialLayers: materials.length,
    repetitionSystems: repetitions.length,
    reviewViewpoints: viewpoints.length,
    detailInventory: details.length
  };
  const requiredDepth = tier ? { ...COMPLEXITY_THRESHOLDS[tier] } : null;
  if (requiredDepth) {
    for (const [region, required] of Object.entries(requiredDepth)) {
      const actual = actualDepth[region as keyof typeof actualDepth];
      if (actual < required) {
        issues.push({
          region,
          message: `${region} is below the ${tier} depth threshold (${actual} < ${required})`
        });
      }
      const declared = declaredMinimums?.[region];
      if (region !== "detailInventory" && typeof declared !== "number") {
        missing(issues, `qualityContract.minimumSpecDepth.${region}`);
      } else if (
        region !== "detailInventory" &&
        typeof declared === "number" &&
        declared < required
      ) {
        issues.push({
          region: `qualityContract.minimumSpecDepth.${region}`,
          message: `declared minimum ${declared} is below the canonical ${tier} threshold ${required}`
        });
      }
    }
  }
  const ids = components.map((item) => item.id).filter(nonEmptyString) as string[];
  if (ids.length !== components.length) {
    issues.push({ region: "componentTree", message: "every component requires a non-empty id" });
  }
  if (new Set(ids).size !== ids.length) {
    issues.push({ region: "componentTree", message: "component ids must be unique" });
  }
  if (spec.suitability === "reject") {
    issues.push({ region: "suitability", message: "a rejected subject cannot pass the spec gate" });
  }
  return { valid: issues.length === 0, tier, actualDepth, requiredDepth, issues };
}
