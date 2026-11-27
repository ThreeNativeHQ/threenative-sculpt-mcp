# Sculpt MCP Workflow & Tools Reference

Projects in Studio do **not** contain Python `forge/*.py` scripts — author TypeScript Three.js factories directly and drive verification through the `sculpt_*` MCP tools.

## MCP Tools

- `sculpt_plan`: get ordered pass names and relevant `grimoire` topic URIs for an asset task.
- `sculpt_grimoire`: read a concise technique page (`topic` string).
- `sculpt_spec_gate`: validate the `ObjectSculptSpec` contract (`schemaVersion: "2.1"`, `targetName`, `suitability`, `coordinateFrame`, `silhouette`, `componentTree`, `materials`, `repetitionSystems`, `proceduralStrategy`, `preSpecAssessment`, `qualityContract`, `qualityTargets`) before writing code.
- `sculpt_gate_pass`: validate visual/pass evidence before moving to the next build pass.
- `sculpt_image_inspect`: inspect nonblank render bounds, alpha coverage, contrast, and clipping.
- `sculpt_image_compare`: compute reference-vs-render CIEDE2000 palette distance and luminance/edge diagnostics (semantic visual review is still mandatory).

## Stage R Animation & Rigging Tools (when animated/skinned)

- `sculpt_rig_reference`: inspect GLB skin joints, inverse binds, channels, and sampled clips.
- `sculpt_rig_spec_gate`: validate structural rig hierarchy, matrices, and 4-slot normalized skin weights.
- `sculpt_skin_condition`: blend 4-slot skin weights smoothly across multipart seams (Gate R2).
- `sculpt_mesh_parity`: freeze/verify mesh position/normal/UV/index buffers before and after skinning.
- `sculpt_action_design`: resolve limb chains, measure foot slide, accept/synthesize walk or run gait clips.
- `sculpt_rig_gate`: run all Stage R G1–G12 gates without short-circuiting.

## Build Passes & Tessellation Budget

Ordered passes: `blockout` → `structural-pass` → `form-refinement` → `material-pass` → `lighting-pass` → `interaction-pass` → `optimization-pass`.

| `targetTriangles` | Tier | Sphere | Cylinder (H segs ≥ 4, cone H segs = 1) |
| --- | --- | --- | --- |
| ≤ 6,000 | `low` | 16×10 | 10×4 |
| ≤ 60,000 | `standard` | 32×20 | 24×8 |
| > 60,000 / unset | `hero` | 64×40 | 48×16 |

## Pre-Browser Executed Geometry Checks

Before capturing browser screenshots, inspect the built `THREE.Group` and `root.userData.sculptRuntime`:
- Left/right `-l`/`-r` pairs must mirror sagittally (`x -> -x`, triangle winding flipped back) rather than rotating 180°.
- Attached parts use `attachment.parentSocket` with explicit overlap/embed into the parent so no child floats in mid-air.
- Every mesh has a unique semantic name; surface relief sets `userData.explodeWithParent = true`.
- Export binary GLB self-contained with embedded textures and materials via `GLTFExporter({ binary: true })`.
