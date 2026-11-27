# threenative-sculpt-mcp

Twelve fail-closed MCP tools for turning a reference image into user-owned procedural Three.js
source. The server evaluates plans, `ObjectSculptSpec` depth, captured frames, pass gates and the
complete Stage R animation contract; it never generates source or launches a browser.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/server.js
```

The server communicates over stdio. Configure an MCP host to launch
`./node_modules/.bin/threenative-sculpt-mcp` from the generated project.

## Surface

- `sculpt_plan` — validate a reference and return the locked pass order, 2–4 essential grimoire URIs (`optionalTopics` for more), and a `specTemplate` that passes `sculpt_spec_gate` once its `<fill>` placeholders are replaced (optional `tier`);
  `profile: "animated-character"` appends the ordered Stage R steps.
- `sculpt_spec_gate` — validate the retained `ObjectSculptSpec` contract and depth minimums.
- `sculpt_compare` — compare an existing capture with the reference globally and by normalized region.
- `sculpt_pass_gate` — return `advance`, `retry`, or `stop`; uncertainty can never advance.
- `sculpt_grimoire` — read a topic; unknown or unsafe topics fail with the valid-topic list.
- `sculpt_rig_reference` and `sculpt_rig_spec_gate` — read GLB-owned index spaces and validate
  structural rig payloads.
- `sculpt_clip_measure` and `sculpt_action_design` — measure clips, decide loops, resolve chains,
  check foot slide and accept explicit gait bands.
- `sculpt_skin_condition` and `sculpt_mesh_parity` — condition multipart bindings and freeze/verify
  packed geometry buffers while reporting legal skin attributes.
- `sculpt_rig_gate` — evaluate all G1–G12 observations; any failed or unevaluated gate is an MCP
  error while all twelve results remain in the report.

Every technique-safe page is exposed as `sculpt://grimoire/<topic>`.

The source repository retains the complete upstream grimoire verbatim. The served resource
index is narrower: pages containing concrete fenced GLSL or material recipes are rejected by
both resource discovery and `sculpt_grimoire`. This keeps the MCP surface technique-oriented;
the agent authors the game's materials and shaders in `src/render/`.

The animation VFX resource is a measured-event hand-off: ThreeNative's `AnimationPlayer`,
`attachToBone` and `GPUParticles3D` provide the runtime mechanisms, while the generated game owns
the effect's appearance. An event table measured from the real clip is required; timeout guesses
are not accepted.

Upstream does not contain a standalone JSON Schema for `ObjectSculptSpec`. This fork documents
its explicit MCP runtime subset in `schema/object-sculpt-spec.runtime.schema.json` and applies
the upstream simple/moderate/complex/ultra-complex depth thresholds in code. The eight locked
passes are blockout, structural, form, material, surface, lighting, interaction, and optimization.

The nested shapes consumed by `sculpt_spec_gate` are objects: the tier is
`preSpecAssessment.complexity.tier`, and inventory entries are in
`preSpecAssessment.detailInventory.details`. This complete simple-tier example is also packaged
as `examples/simple-object-sculpt-spec.json`:

```json
{
  "schemaVersion": "2.1",
  "targetName": "Reference object",
  "suitability": "pass",
  "coordinateFrame": {},
  "silhouette": {},
  "componentTree": [{ "id": "root", "level": "macro", "localFeatures": [] }],
  "materials": [{ "id": "base" }],
  "repetitionSystems": [],
  "proceduralStrategy": ["Build the observed silhouette"],
  "preSpecAssessment": {
    "complexity": { "tier": "simple" },
    "detailInventory": {
      "details": [
        { "id": "primary-outline" },
        { "id": "dominant-proportion" },
        { "id": "material-break" }
      ]
    }
  },
  "qualityContract": {
    "minimumSpecDepth": {
      "macroComponents": 1,
      "mesoComponents": 0,
      "microFeatureGroups": 0,
      "materialLayers": 1,
      "repetitionSystems": 0,
      "reviewViewpoints": 2
    }
  },
  "qualityTargets": { "reviewViewpoints": ["front", "three-quarter"] }
}
```

Deterministic pixel comparison is diagnostic evidence. `sculpt_pass_gate` requires a semantic
review of the same image pair and its critical features; absent or ambiguous review evidence
returns `retry` (or `stop` at the configured final attempt), never `advance`.
Low deterministic scores and regional confidence produce correction guidance but do not block
an otherwise passing semantic review when `compareResult.ambiguous` is `false`. An explicitly
ambiguous comparison still blocks advancement.

`sculpt_compare` reads PNG, JPEG, WebP, GIF, AVIF, and TIFF through Node's `sharp` package.
It rejects missing, zero-byte, undecodable, and all-one-colour captures. It does not include
Python, uv, Playwright, browser automation, source generation, or runtime game code.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm pack --dry-run
```

The Stage R release check is a development-only verifier and takes a separately cloned showcase;
it is not part of the published runtime:

```sh
pnpm verify:release -- --server dist/server.js --showcase <showcase-root> --glb <raz.glb> --out <evidence-dir>
```

The retained material, adaptations, ports, and resource-safety filter are described in
`NOTICE`; the package is Apache-2.0.
