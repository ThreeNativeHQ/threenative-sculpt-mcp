# Animation contract — 1.5.2

Read this when a character rig must **move**, not merely bind. The payload and bind contract lives
in `procedural_rigging_contract.md`; this page covers the measured animation contract after a
skeleton exists. The complete derivation and failure log are in the upstream
`docs/pipelines/character-rigging-animation-1.5.2.md`.

Every threshold is a fraction of figure height `H`, never an absolute unit. A rig at another scale
converts; no module may assume `H == 1.0`.

## The one rule

> Nothing about a rig is believed until it has been evaluated at a sampled time and compared
> against the value the track says it should have. A clip that exists is not a clip that plays.

Two separate 1.5.1 bugs produced a plausible scene with zero motion: clips held actions, the mixer
held state, buttons dispatched, and nothing moved. Both were found only by measuring.

## Stage order

1. Read the contract and classify deform versus technical nodes.
2. Read the rig reference from the GLB, including skin joint order and inverse binds.
3. Repair mesh defects before freezing evidence.
4. Freeze packed positions, normals, UVs and indices before rig work.
5. Validate the structural rig payload.
6. Bind additively: add the skeleton, `skinIndex` and `skinWeight` only.
7. Verify post-bind buffers against the frozen manifest.
8. Measure every clip, classify it, name it from measurements and decide looping from pose return.
9. Run every gate; an absent observation is `unevaluated`, never a pass.

## Hard rules

- A node is a deform bone **iff** it appears in `skin.joints`; never infer from names.
- Use identity bind space and an offset derived from mesh bounds alone.
- A non-zero `scaleDelta` is a tripwire and must be surfaced before skin conditioning proceeds.
- Looping requires `poseReturn <= 0.5°` and hip return `<= 0.01H`; missing pose return is undecidable.
- Names that imply intent carry `inferred: true`; kinematics cannot distinguish a strike from a stumble.
- Proximity conditioning may trade holes for creases, so both measurements remain visible.
- A lazy character must refresh animation tickers after its payload resolves.
- Remove presentation offsets before rig ticks and re-apply them afterward.

## Gates

`G1` binding reaches node · `G2` deformation finite · `G3` bind restore · `G4` weights normalised ·
`G5` indices in range · `G6` every visible mesh bound · `G7` medial/lateral · `G8` foot contact ·
`G9` no joint scale · `G10` skin-integrity sweep · `G11` mesh parity · `G12` rig-reference integrity.

The `sculpt_rig_gate` call returns all twelve results. Any `fail` or `unevaluated` result fails the
overall report; no gate short-circuits the others.

## Provenance

Adapted from img2threejs v1.5.2 tag `d6815db757c1eb435ae55f91fb375a7a98ddf28b` and its
`grimoire/readiness/animation_contract.md`. The published sculpt-MCP keeps the Node runtime pure;
the browser, native runtime and Blender are verification hosts, not package dependencies.
