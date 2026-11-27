# Standard Character Pipeline Contract

1. **Routes**:
   - Procedural TypeScript (`THREE.Group` factory -> optional GLB export via `GLTFExporter({ binary: true })`): build modular body/head/limb/visor/pack parts under `root.userData.sculptRuntime`.
   - External GLB/rig adaptation (`threenative-assets` / Stage R gates): inspect with `sculpt_rig_reference`, preserve hierarchy and buffers (`sculpt_mesh_parity`).
2. **Scene Contract**:
   - Name every semantic mesh (`head`, `torso`, `arm-l`, `arm-r`, etc.); mirror `-l`/`-r` parts sagittally (never rotate 180° around Y).
   - Continuous face/head volume with seated sockets and attached eye/visor/accessory meshes (positive embed/overlap, zero floating parts).
   - Stylized hair/crests use volumetric clumps with rear/side coverage (never flat cards).
3. **Coordinate & Rig Invariants**:
   - Y-up, right-handed, metric scale; character stands on `y = 0` ground plane facing `+Z` (or project contract forward axis).
   - If skinned: root joint at index `0` (`parent = null`), parent index `<` child index, 4 finite nonnegative normalized weights summing to `1.0` per vertex, validated with `sculpt_rig_spec_gate`, `sculpt_skin_condition`, and `sculpt_rig_gate`.
4. **Visual & Pose Checks**:
   - Capture multi-angle views (front/hero, 3/4 left & right, side, rear, head close-up) plus stress poses when rigged (neutral, limb raise, stride/jump).
   - Acceptance order: silhouette & proportions → joint seating → face/head read → materials/lighting → animated deformation.
