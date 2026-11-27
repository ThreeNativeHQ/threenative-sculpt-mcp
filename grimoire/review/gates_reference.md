# Gates Reference

Mandatory verification rules for every `sculpt_*` asset build:

1. **Suitability (`grimoire/intake/validation_rubric.md`)**: verify clear silhouette, visible material zones, and reconstructible 3D mass before planning (`pass` / `conditional` / `request-input` / `stop`).
2. **Spec Gate (`sculpt_spec_gate`)**: validate `ObjectSculptSpec` depth (`macro`/`meso`/`micro`, `detailInventory.details`, `minimumSpecDepth`, `reviewViewpoints`) BEFORE writing geometry code.
3. **Multi-Angle Or It Didn't Happen**: validate non-planar 3D depth across front, 3/4, side/top, and rear views — never let a flat card/plane pass on a single front capture.
4. **Chirality (HARD)**: every `-l` / `-r` pair must be a sagittal mirror (`x -> -x` + winding flip), NEVER a 180° Y rotation (which produces two left hands/feet) and NEVER wrong on both sides simultaneously (`medial_lateral_bias` matches reference).
5. **Interior vs Silhouette (`sculpt_image_compare`)**: silhouette IoU only measures outer outline (~11% of pixels); always inspect interior forms, shading gradients, bevels, and contact seams in a 3/4 capture.
6. **Hair / Scalp Coverage (if character has hair)**: hair masses must stay outside the skull shell with side/rear volume — never widen hair off the skull to fake silhouette area, and never use single flat cards.
7. **Rig & Stage R Gates (when animated)**: validate joint hierarchy (`parent = null` at root index `0`, parent index `<` child), 4-slot normalized skin weights, mesh buffer parity (`sculpt_mesh_parity`), and stress-pose deformation (`sculpt_rig_gate`).
8. **Assembly & Attachment Structure**: every child appendage connects to `attachment.parentSocket` with positive embed/overlap (no mid-air gaps); every mesh is named; surface detail sets `userData.explodeWithParent = true`; root exposes `root.userData.sculptRuntime`.
9. **Material Channels**: author albedo, roughness, metalness, normal/bump, and AO as independent PBR channels — never alias baked photo shadows or raw albedo directly into roughness/normal/AO.
10. **Visual Pass Acceptance (`sculpt_gate_pass`)**: `continue` requires a nonblank capture, reference comparison, global score ≥ threshold (default `0.7`), and no failing critical subsystem or blocking 3D realism defect.
