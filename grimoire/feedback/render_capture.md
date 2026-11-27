# Browser Screenshot Feedback

## Capture & Camera Discipline
- Lock review cameras deterministically before capture (`controls.enabled = false` or fixed viewpoint preset) so interactive damping/orbit never tilts screenshots.
- Match reference aspect/framing so comparisons evaluate geometry and materials rather than distance errors.
- Capture at minimum `front` and `three-quarter` views (and `side`/`rear` for 3D props/characters).

## Layered Inspection Order (max 5 critical subsystems per pass)
Group repeated modules into one system (e.g. `leg-assembly`, `beacon-housing`). Evaluate in order:
1. **Silhouette & proportion** (`silhouetteProportion`): bounding ratios, taper, negative space, symmetry.
2. **Component structure** (`componentStructure`): parent/child seating, sockets, overlaps, zero floating parts.
3. **Form detail** (`formDetail`): chamfers, curvatures, seams, ridges, openings, non-flat thickness.
4. **Surface response** (`materialSurface`): de-lit albedo zones, roughness variance, metalness accuracy, emissive accent contrast, bump/normal/AO.
5. **Lighting & framing** (`lightingCamera`): readable key/fill/rim separation, ground/contact shadow, zero clipped highlights or crushed darks.

## Action Decision Matrix
- Wrong/missing part → `refine-spec`.
- Bad framing/dark lighting/wrong material values or mesh placement → `refine-code`.
- Missing back/occluded detail → `request-input` (or conservative symmetry inference flagged in notes).
- All critical layers & global score ≥ `0.7` (with non-flat 3D volume verified) → `continue` (call `sculpt_gate_pass`).
