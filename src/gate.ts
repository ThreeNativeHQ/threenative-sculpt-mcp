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
  if (compare.ambiguous) {
    reasons.push("deterministic comparison evidence is explicitly ambiguous");
  }
  if (
    !Number.isFinite(compare.overall.score) ||
    !Number.isFinite(compare.overall.confidence)
  ) {
    reasons.push("deterministic comparison evidence contains non-finite values");
  } else {
    if (compare.overall.score < input.threshold) {
      corrections.add(
        `use the diagnostic comparison score ${compare.overall.score} to target visual corrections`
      );
    }
    if (compare.overall.confidence < input.minimumConfidence) {
      corrections.add("treat the low-confidence deterministic diagnostics cautiously");
    }
  }
  if (compare.regions.length === 0) reasons.push("comparison evidence contains no regions");
  for (const region of compare.regions) {
    if (!Number.isFinite(region.score) || !Number.isFinite(region.confidence)) {
      reasons.push(`region "${region.id}" contains non-finite evidence`);
    } else if (region.score < input.threshold) {
      corrections.add(`use low diagnostic score for region "${region.id}" to target corrections`);
    } else if (region.confidence < input.minimumConfidence) {
      corrections.add(`treat region "${region.id}" diagnostics as low-confidence`);
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
      reasons: [
        "comparison is not ambiguous and semantic review plus critical features meet their thresholds"
      ],
      corrections: [...corrections]
    };
  }
  return {
    decision: input.attempt >= input.maxAttempts ? "stop" : "retry",
    passId: input.passId,
    reasons: [...new Set(reasons)],
    corrections: [...corrections]
  };
}
