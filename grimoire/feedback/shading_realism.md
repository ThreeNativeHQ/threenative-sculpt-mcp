# Material & Lighting Realism

Use this reference when geometry/silhouette holds but materials or lighting look flat or plastic. Fix via **LookDev Reset**, not geometry tweaks.

## Material-Pass Contract
1. **Multi-tone albedo palette**: never one flat hex across an object. Sample de-lit base colors (strip baked light/highlights); deepen paint hues slightly so bright studio lighting does not wash them out.
2. **Independent PBR channels**: author albedo, roughness, metalness, bump/normal, and AO independently — never alias albedo into roughness/normal/AO.
   - Coated/anodized metals: avoid `metalness: 1.0` with bright cool env (turns albedo blue/chrome). Use `metalness ~0.35–0.7` + `roughness` variation (`0.15–0.35`) + subtle `clearcoat` + moderate `envMapIntensity`.
   - Patterned/organic stone/wood/cloth: vary roughness (worn ridges glossier, cavities matte) + normal/bump relief readable under grazing key light.
   - Procedural textures: keep repeating maps seamless, ≥1024px for hero close-ups, wait for `map.image.complete` before screenshot capture.
3. **Locality & frequency bands**: combine macro zones, meso wear/grime/cavities, and micro grain matched to object scale without visible tiling.
4. **Silhouettes vs normals**: if a ridge, groove, or plate edge changes silhouette outline, author geometry rather than flat normal maps.

## Lighting-Pass Contract
- Key light: crisp warm/neutral directional key with tight shadow frustum, `shadow.radius`/softness, and subtle ground shadow (`opacity ~0.16–0.35`).
- Fill & rim: lower-intensity cool/warm hemisphere or fill light + rim backlight for silhouette separation without flattening shadows.
- Exposure & tone mapping: `ACESFilmicToneMapping` with balanced exposure so sand/highlights don't blow out and darks don't crush.
- Validate under neutral lighting AND grazing close-up lighting (a material that only looks good under one camera/light still needs roughness/normal work).
