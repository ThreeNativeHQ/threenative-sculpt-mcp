# Object Image Validation Rubric

Decide `suitability` before writing geometry:

- **`pass`**: clear single subject, strong readable silhouette, major material zones visible, hidden back inferable from symmetry/context, reconstructible procedurally.
- **`conditional`**: single angle only (use rotational/bilateral symmetry or conservative back inference), minor occlusion with clear macro form, or simplified silhouette accepted.
- **`request-input` / `reject`**: scene (not an object), critical mass hidden/cropped/blurry, ambiguous subject, or primarily smoke/caustics/fluid without solid structure.

## Character Suitability
Do not reject stylized humans/robots/creatures for cloth or stylized hair:
- Stylized characters/robots: classify `pass`/`conditional` (`character/reconstruction.md`), define proportions in head-units or bounding ratios, infer rear conservatively, and verify from 3/4 + side/rear views.
- High-likeness portraits from 1 blurry/front-only photo: state confidence per region and request orthographic/3/4 views if realism is critical.

## Complex Object Bar
For `moderate`+ targets, ensure `macro` body parts, `meso` sub-assemblies, `micro` surface details, multi-layer PBR materials, and at least 2–3 named review viewpoints (`front`, `three-quarter`, `side`/`top`).
