# Character / Creature Head Construction

Heads carry likeness and are least forgiving of proportion error. Measure ratios relative to `HH` (head height, crown to chin) and validate depth from top/3/4 views, not front alone.

## Proportion Checklist
- Measure from reference: skull width/HH, skull depth/HH, eye-line height from crown (lower eye line `>0.55` reads younger/cuter; higher `≤0.45` reads older/predatory), interocular spacing relative to skull width, muzzle/nose protrusion, jaw setback, ear/horn span & rake angle.
- Guard against human-anatomy bias on creatures/robots: measure top-view width-to-depth ratio explicitly instead of rounding into a human sphere or dog snout.

## Blockout & Joins
1. **Primary masses**: cranium ellipsoid, face/visor/muzzle capsule/block overlapping (never merely touching, which leaves seams), recessed or inset jaw/chin.
2. **Sockets & brow**: Boolean/inset eye sockets, supraorbital/visor brow rim tilting eye read as expressive vs intimidating.
3. **Appendages**: mirror `-l`/`-r` ears/horns sagittally (`x -> -x`, flip winding); seat into temporal/cranial sockets (`embed > 0`).
4. **Surface details**: sharp lip/visor creases without pinching, recessed nostrils/vents, distinct specular cornea/visor lens (`roughness 0.05–0.15`).
5. **Deformation topology (if rigged)**: ≥4 concentric loops around eyes, ≥3 around mouth, clean jaw pivot below/behind teeth/mouth corners so 45° gape doesn't stretch cheeks.
6. **Verify**: inspect front, 3/4, and top views so depth matches silhouette before finalizing materials.
