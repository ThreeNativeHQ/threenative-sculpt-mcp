# Self-Correction Loop Reference

## Transparency Rule
After each refinement pass, log:
- **Exact change:** concrete coordinate/parameter/material delta made.
- **Remaining gap:** what still diverges from reference (never call an "improved" feature "done").
- **3D Realism Check:** 2D silhouette/pixel metrics are blind to flat slabs, missing bevels, wrong metallic response, and missing depth in 3/4 views. Always judge 3D form from an angled view.

## Review Order
1. Capture the live viewport from named review viewpoints (`front`, `three-quarter`, plus orbit/detail views).
2. Compare against `reference` and `ObjectSculptSpec` across silhouette, component attachment, form bevels, PBR surface response, and lighting.
3. Run `sculpt_image_inspect` / `sculpt_image_compare` as diagnostic aids (never sole pass authority).
4. Pick one action:
   - `refine-spec`: missing/wrong component, wrong primitive family, wrong proportions, missing local features/materials.
   - `refine-code`: spec is right but mesh coordinates, hierarchy, materials, camera, or lighting don't match.
   - `request-input`: critical shape/material occluded and uninferable.
   - `continue`: visual fidelity and every critical subsystem pass threshold.
   - `stop`: target fidelity reached.

## Photo-vs-Procedural Calibration
When comparing a procedural render to a real photo or stylized artwork, background, lens, and lighting differ — never distort geometry just to chase raw SSIM. Judge silhouette alignment, part placement, palette ΔE (`sculpt_image_compare`), and readability in 3/4 view.

## Fidelity Scale
- `0.2`: blockout primitives only
- `0.4`: silhouette recognizable, incomplete parts
- `0.6`: macro + meso forms present, weak surface detail
- `0.75`: solid game-ready match with clean materials & lighting
- `0.85+`: strong reference parity across multiple angles
