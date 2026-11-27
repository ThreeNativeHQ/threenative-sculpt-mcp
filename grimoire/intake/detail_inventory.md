# Detail Inventory

Scan zone-by-zone (`component-zones` or `grid-3x3`/`4x4`) and record every identity-defining mark in `preSpecAssessment.detailInventory.details[]` linked via `mapsTo` to a `component.localFeatures[]` or `material.localOverrides[]`. Unmapped prose fails review.

Complexity floors for `detailInventory.details`: `simple ≥ 3`, `moderate ≥ 6`, `complex ≥ 10`, `ultra-complex ≥ 16`.

## Detail Kinds & Three.js Implementation

| Kind | Implementation |
| --- | --- |
| `gloss` | Low `roughness` (`0.05–0.2`) or `clearcoat` / `clearcoatRoughness` on `MeshPhysicalMaterial`; `anisotropy` for brushed streaks; align highlight with key light. |
| `bevel` | Real chamfered geometry (`bevelRadius ~ 0.02–0.08`, 1–4 segments) when silhouette/rim light catches an edge — never texture-only. |
| `fastener` | `InstancedMesh` bolts/rivets/screws with count, spacing rule, head shape, and metallic/low-roughness crown. |
| `linework` / `seam` / `groove` / `ridge` | Real recessed groove or raised ridge for depth that catches light; thin AO/albedo stripe for painted lines or panel seams. |
| `stain` / `scratch` / `chip` / `decal` | `material.localOverrides` with `cavityBias`, directional wear, underlayer contrast, or positioned decal plate/map. |
| `emissive` | Separate `emissive` + `emissiveIntensity` material (and nearby accent light if it illuminates adjacent geometry). |
| `hole` | Real geometry cutout / cavity shell (`Shape.holes` or recessed cavity walls), never a flat dark patch. |
| `contour` | Stylized rim light or backface outline pass on silhouette edges. |
