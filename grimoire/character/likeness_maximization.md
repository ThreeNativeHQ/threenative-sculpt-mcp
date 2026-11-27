# Likeness Maximization (Projection & Reference Alignment)

When maximum resemblance to a specific reference is required (rather than a stylized class member):

1. **Match proportions to landmarks**: fit body/face template parameters (head-unit height, limb ratios, visor/eye positions, silhouette width/depth) to observed reference proportions before detailing.
2. **Match camera FOV & pose**: align the verification camera to approximate the reference focal length and yaw/pitch when checking front/reference-match view, then verify 3/4 and rear angles for 3D depth.
3. **De-light albedo**: remove baked studio shadows and specular highlights from reference colors before setting PBR `color`/`map`; supply roughness, metalness, bump/normal, and AO independently so the scene lights shade cleanly.
4. **Conservative rear/side inference**: mirror symmetric anatomy cleanly; mark occluded back details conservatively (matched palette & seam continuity) rather than inventing loud unverified patterns, and report per-region confidence honestly.
5. **Rigging & stylized dial**: build clean articulated/skinned sub-groups under `root.userData.sculptRuntime`, stylized clumps (never flat cards) for hair/foliage, and glossy eye/lens surfaces for crisp catchlights.
