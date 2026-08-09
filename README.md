# threenative-sculpt-mcp

Five fail-closed MCP tools for turning a reference image into user-owned procedural Three.js
source. The server evaluates plans, `ObjectSculptSpec` depth, captured frames, and pass gates;
it never generates source or launches a browser.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/server.js
```

The server communicates over stdio. Configure an MCP host to launch
`./node_modules/.bin/threenative-sculpt-mcp` from the generated project.

## Surface

- `sculpt_plan` — validate a reference and return the locked pass order plus relevant grimoire URIs.
- `sculpt_spec_gate` — validate the retained `ObjectSculptSpec` contract and depth minimums.
- `sculpt_compare` — compare an existing capture with the reference globally and by normalized region.
- `sculpt_pass_gate` — return `advance`, `retry`, or `stop`; uncertainty can never advance.
- `sculpt_grimoire` — read a topic; unknown topics fail with the complete valid-topic list.

Every technique-safe page is exposed as `sculpt://grimoire/<topic>`.

The source repository retains the complete upstream grimoire verbatim. The served resource
index is narrower: pages containing concrete fenced GLSL or material recipes are rejected by
both resource discovery and `sculpt_grimoire`. This keeps the MCP surface technique-oriented;
the agent authors the game's materials and shaders in `src/render/`.

Upstream does not contain a standalone JSON Schema for `ObjectSculptSpec`. This fork documents
its explicit MCP runtime subset in `schema/object-sculpt-spec.runtime.schema.json` and applies
the upstream simple/moderate/complex/ultra-complex depth thresholds in code. The eight locked
passes are blockout, structural, form, material, surface, lighting, interaction, and optimization.

Deterministic pixel comparison is diagnostic evidence. `sculpt_pass_gate` requires a semantic
review of the same image pair and its critical features; absent or ambiguous review evidence
returns `retry` (or `stop` at the configured final attempt), never `advance`.

`sculpt_compare` reads PNG, JPEG, WebP, GIF, AVIF, and TIFF through Node's `sharp` package.
It rejects missing, zero-byte, undecodable, and all-one-colour captures. It does not include
Python, uv, Playwright, browser automation, source generation, or runtime game code.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm pack --dry-run
```

The retained material, adaptations, ports, and resource-safety filter are described in
`NOTICE`; the package is Apache-2.0.
