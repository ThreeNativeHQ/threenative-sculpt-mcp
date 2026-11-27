# Image Analysis Protocol

Inspect the reference visually before writing any `ObjectSculptSpec`. State observed facts first; mark inferences explicitly. Use objective 3D object-space coordinates (`front/back/lateral/proximal/distal`), not 2D screen-left/right.

## 8-Layer Extraction Checklist

| Layer | What to observe | Maps to spec field |
| --- | --- | --- |
| 1. Identification | Noun class, `primaryDomain` (`object`\|`character`\|`hybrid`), suitability | `targetName`, `suitability`, `preSpecAssessment.complexity.tier` |
| 2. Form & silhouette | Bounding proportions relative to a reference axis, symmetry, primary primitives | `silhouette`, `coordinateFrame`, `proceduralStrategy` |
| 3. Hierarchy | Separate `macro` bodies, `meso` sub-assemblies, `micro` feature groups | `componentTree[]` (`level`: macro/meso/micro) + `minimumSpecDepth` |
| 4. Spatial joins | 3D contacts (`socket`/`embed`/`overlap`/`butt`), parent-child sockets | `attachment` fields & overlap depth (no floating parts) |
| 5. PBR surfaces | De-lit albedo, metalness (`0` vs `1`), roughness bands, relief/bump, opacity | `materials[]` + `localOverrides` |
| 6. Color & finish | Hue/value/saturation per zone, finish (`matte`/`satin`/`gloss`/`metallic`), gradient stops | `materials[]` colors/roughness/metalness |
| 7. Identity marks | Signature shapes, logos, decals, seams, wear, emissive accents | `preSpecAssessment.detailInventory.details[]` (`{id}`) |
| 8. Uncertainties | Occluded back/sides, blurry regions (`occluded`/`hidden`/`inferred`) | Spec notes or `request-input` |

Domain add-ons when applicable:
- Characters/hybrids: also read `grimoire/character/reconstruction.md`.
- CS2 skins: also read `grimoire/build/cs2_finishes.md`.
