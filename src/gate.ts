import type { PassId } from "./constants.js";
import type { SculptCompareResult } from "./image.js";

export interface SemanticFeatureReview {
  id: string;
  score: number;
  threshold: number;
  critical: boolean;
}

export interface SemanticReview {
  score: number;
  confidence: number;
  notes: string;
  criticalFeatures: SemanticFeatureReview[];
}

export interface PassGateInput {
  passId: PassId;
  compareResult: SculptCompareResult;
  semanticReview?: SemanticReview;
  threshold: number;
  minimumConfidence: number;
  attempt: number;
  maxAttempts: number;
}

export interface PassGateResult {
  decision: "advance" | "retry" | "stop";
  passId: PassId;
  reasons: string[];
  corrections: string[];
}

export function gatePass(input: PassGateInput): PassGateResult {
  const reasons: string[] = [];
  const corrections = new Set<string>();
  const compare = input.compareResult;
  if (compare.status !== "evidence" || compare.authority !== "diagnostic-only") {
    reasons.push("comparison evidence contract is missing or unrecognized");
  }
  if (
    compare.ambiguous ||
    !Number.isFinite(compare.overall.confidence) ||
    compare.overall.confidence < input.minimumConfidence
  ) {
    reasons.push("deterministic comparison evidence is ambiguous or low-confidence");
  }
  if (!Number.isFinite(compare.overall.score) || compare.overall.score < input.threshold) {
    reasons.push(`deterministic comparison score is below ${input.threshold}`);
  }
  for (const region of compare.regions) {
    if (
      !Number.isFinite(region.score) ||
      !Number.isFinite(region.confidence) ||
      region.confidence < input.minimumConfidence
    ) {
      reasons.push(`region "${region.id}" has ambiguous evidence`);
    } else if (region.score < input.threshold) {
      reasons.push(`region "${region.id}" score is below ${input.threshold}`);
    }
    for (const correction of region.corrections) corrections.add(correction);
  }
  const review = input.semanticReview;
  if (!review) {
    reasons.push("semantic image review is required; deterministic pixels cannot advance a pass");
    corrections.add("review the same reference/capture pair and score critical semantic features");
  } else {
    if (!Number.isFinite(review.score) || review.score < input.threshold) {
      reasons.push(`semantic review score is below ${input.threshold}`);
    }
    if (!Number.isFinite(review.confidence) || review.confidence < input.minimumConfidence) {
      reasons.push("semantic review is ambiguous or low-confidence");
    }
    const critical = review.criticalFeatures.filter((feature) => feature.critical);
    if (critical.length === 0) {
      reasons.push("semantic review names no critical features");
    }
    for (const feature of critical) {
      if (
        !Number.isFinite(feature.score) ||
        !Number.isFinite(feature.threshold) ||
        feature.score < feature.threshold
      ) {
        reasons.push(`critical feature "${feature.id}" did not meet its threshold`);
        corrections.add(`correct critical feature "${feature.id}" and review it again`);
      }
    }
  }
  if (reasons.length === 0) {
    return {
      decision: "advance",
      passId: input.passId,
      reasons: ["deterministic diagnostics and semantic critical-feature review are unambiguous"],
      corrections: []
    };
  }
  return {
    decision: input.attempt >= input.maxAttempts ? "stop" : "retry",
    passId: input.passId,
    reasons: [...new Set(reasons)],
    corrections: [...corrections]
  };
}

