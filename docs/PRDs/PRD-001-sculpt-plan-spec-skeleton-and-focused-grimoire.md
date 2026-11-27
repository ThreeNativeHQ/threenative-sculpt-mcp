# PRD-001 — `sculpt_plan` Pre-Valid Spec Skeleton and Bounded Grimoire Selection

**Status:** DONE
**Priority:** P1 — Stops 5–10× `sculpt_spec_gate` retry loops per session (170× `missing required ObjectSculptSpec region` across 12 Studio runs) and 40 KB bulk `sculpt_grimoire` truncations.
**Complexity:** 3 (LOW)
**Owner:** Unassigned
**Depends on:** None

## Context

Forensic trace inspection across 12 recent 30-minute Studio builds (`2026-11-26/27`) shows the `sculpt` lane accounts for **27.6% of total AI spend**, with two recurring token leaks in `threenative-sculpt-mcp`:

1. **`sculpt_spec_gate` schema thrash (90 calls across 12 runs, up to 10 per session):**
   - `cairn-climb-d5c76d18`: `spec_gate=10, compare=4, pass_gate=5`; `racing-d36ed63f`: `spec_gate=5, compare=5, pass_gate=8`.
   - Failure phrase counts across the 12 runs: **`170×`** `missing required ObjectSculptSpec region`, **`25×`** `must contain non-empty steps`, **`~85×`** `below the moderate/complex depth threshold (0 < N)`, **`11×`** `must be pass, conditional, or reject`, **`9×`** `must be simple, moderate, complex, or ultra-complex`.
   - `sculpt_plan` (`src/index.ts:162-192`) validates the reference image and lists `grimoireResources`, but leaves agents to reconstruct the deeply nested `ObjectSculptSpec` schema (`REQUIRED_REGIONS` in `src/spec.ts:40-51` and `COMPLEXITY_THRESHOLDS` in `src/constants.ts:14-51`) from prose docs — producing **350–790 line (10–20 KB)** `.agent/sculpt/*.json` files after 5–10 full-context retries.
2. **40 KB `sculpt_grimoire` bulk dumps:**
   - `relevantTopics()` (`src/index.ts:110-134`) returns 8–12+ topics on every `sculpt_plan` call. In 10 of 12 runs, Codex ran `Promise.allSettled(p.grimoireResources.map(sculpt_grimoire))`, hitting the exact **39.8–40.6 KB** tool-output truncation ceiling in a single turn.

## Solution

1. **Generate a pre-valid spec skeleton in `src/spec.ts` and embed it in `sculpt_plan`:**
   - Add `buildSpecSkeleton(tier: ComplexityTier, targetName: string)` in `src/spec.ts` derived directly from `REQUIRED_REGIONS` (`src/spec.ts:40-51`) and `COMPLEXITY_THRESHOLDS` (`src/constants.ts:14-51`), pre-populating valid `qualityContract.minimumSpecDepth`, `coordinateFrame`, `silhouette`, `proceduralStrategy`, `preSpecAssessment`, `qualityTargets.reviewViewpoints`, and starter `componentTree`/`materials` slots matching the tier counts.
   - Expose optional `tier` input (default `"moderate"` or inferred from `profile`) on `sculpt_plan` (`src/index.ts:162-192`) and return `specTemplate` in `sculpt_plan`'s JSON payload so agents populate real asset values on attempt 1 instead of playing schema whack-a-mole.
2. **Bound default grimoire recommendations & clarify `sculpt_spec_gate` errors:**
   - Split `relevantTopics()` (`src/index.ts:110-134`) into `grimoireResources` (only the **2–3 essential topics**, e.g. `intake/quality_contract` and `build/geometry_patterns`, plus `readiness/action_rigging` only for `animated-character`) and `optionalTopics` (extended reading), keeping combined recommended reads well under 14 KB.
   - Update `gateObjectSculptSpec()` (`src/spec.ts:53-170`) to return concise dot-paths and exact expected counts in a compact `issues` array without redundant prose.

## Non-Goals

- Weakening `COMPLEXITY_THRESHOLDS` (`src/constants.ts:14-51`) or removing structural/depth checks from `gateObjectSculptSpec()`.
- Bypassing Stage R rig/clip gates for `character` or `animated-character` profiles.

## Acceptance Criteria

- [x] AC-1 [local]: `buildSpecSkeleton(tier, targetName)` emits a concise JSON template whose structural keys, `suitability`, `complexity.tier`, `qualityContract.minimumSpecDepth`, and slot lengths match `COMPLEXITY_THRESHOLDS[tier]` so populating non-empty strings passes `gateObjectSculptSpec()` on the first call — proof: `pnpm test` — Evidence: test/spec.spec.ts `buildSpecSkeleton` passes `gateObjectSculptSpec` (valid, no issues) and the runtime JSON schema for all 4 tiers; 70/70 tests pass.
- [x] AC-2 [local]: `sculpt_plan` returns `specTemplate` and bounds default `grimoireResources` to `<= 3` essential topics (`<= 4` for `animated-character`), with extended pages moved to `optionalTopics` and total recommended grimoire bytes `< 14 KB` — proof: `pnpm test` — Evidence: test/mcp.spec.ts bounds generic/character plans to 3 topics and animated-character to 4, all under 14 KB (max 11.4 KB), `optionalTopics` carries the rest, `specTemplate` passes the gate. Note: `build/geometry_patterns` is 26 KB and the safety filter already rejects it ("Material Recipes" heading), so it was never served and is not an essential topic.
- [x] AC-3 [local]: Existing spec/gate/rig/parity suites, TypeScript build, and package lint/typecheck pass without regression — proof: `pnpm typecheck && pnpm test && pnpm build` — Evidence: `pnpm typecheck && pnpm test && pnpm build` all exit 0 (14 files, 70 tests). Gate depth messages now read `<json path> needs N (tier), has M`.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Pre-valid `ObjectSculptSpec` skeleton | `buildSpecSkeleton()` (`src/spec.ts`) → `sculpt_plan` (`src/index.ts:162-192`) | Replaces blank-slate schema guesswork that caused 5–10 `sculpt_spec_gate` retries | AC-1 |
| Bounded default grimoire topic list | `relevantTopics()` (`src/index.ts:110-134`) reading `loadGrimoireCatalog()` (`src/grimoire.ts:56-80`) | Replaces 8–12+ unconditional topics causing 40 KB truncation dumps | AC-2 |
| Dot-path `SpecGateIssue` diagnostics | `gateObjectSculptSpec()` (`src/spec.ts:53-170`) | Tightens gate failure feedback to single-pass actionable JSON paths | AC-3 |

## Execution Phases

#### Phase 1: `buildSpecSkeleton()` and `sculpt_plan` Integration
**Status:** DONE
**Files:** `src/spec.ts`, `src/index.ts`
**Implementation:** Implement `buildSpecSkeleton(tier, targetName)` using `REQUIRED_REGIONS` and `COMPLEXITY_THRESHOLDS`; add optional `tier` param and `specTemplate` field to `sculpt_plan` response in `src/index.ts:162-192`.
- [x] `sculpt_plan` returns `specTemplate` that passes `gateObjectSculptSpec()` once placeholder slots are filled across all 4 complexity tiers — proof: `pnpm test` — covers AC-1.

#### Phase 2: Bounded `relevantTopics()` and Concise Gate Diagnostics
**Status:** DONE
**Files:** `src/index.ts`, `src/spec.ts`
**Implementation:** Return only the 2–3 core topics in `grimoireResources` (moving secondary pages to `optionalTopics`), add a response-size guard, and normalize `gateObjectSculptSpec()` issue messages to exact JSON paths + required counts.
- [x] Recommended grimoire pages stay `<= 3` topics (`<= 4` animated) and `< 14 KB` total — proof: `pnpm test` — covers AC-2.

#### Phase 3: Regression Tests and Package Build Gate
**Status:** DONE
**Files:** `src/__tests__/` (or existing spec/index test suite)
**Implementation:** Add unit coverage for `buildSpecSkeleton`, `sculpt_plan` topic bounds, and `gateObjectSculptSpec` error diagnostics, then run full typecheck, tests, and build.
- [x] Package typecheck, tests, and build pass — proof: `pnpm typecheck && pnpm test && pnpm build` — covers AC-1, AC-2, AC-3.
