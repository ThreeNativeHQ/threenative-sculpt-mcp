# Animation-driven VFX — measured events, game-owned appearance

Use this page after `sculpt_clip_measure` and the Stage R gates have produced an observed event
table. It describes the hand-off to a ThreeNative game; it does not prescribe a material, shader,
colour, texture, particle shape or preset.

## Contract

An effect fires because a measured animation event says it should fire. A timeout chosen by eye is
not an event and is not evidence. The event table is required input to the scenario, and the
scenario must fail when it is removed rather than falling back to a guessed delay.

Record at least:

| Field | Meaning |
| --- | --- |
| `clip` | exact source clip name, for example the measured uppercut action |
| `event` | stable event name such as `contact` |
| `time` | measured seconds from the clip start |
| `tolerance` | comparison window justified by the sampled frame interval |
| `bone` | exact attachment bone name from the GLB rig reference |
| `source` | evidence path and sample that produced the event |

The event is a diagnostic observation, not a promise that every animation has the same timing.
Keep one row per clip and event. If a clip has no measured event, do not invent one.

## ThreeNative hand-off

Use the runtime's existing mechanisms:

1. `AnimationPlayer` owns clip playback and exposes the named action that Stage R measured.
2. `attachToBone` anchors the effect to the measured bone, so the effect follows the character's
   actual pose instead of a magic world coordinate.
3. `GPUParticles3D` owns pooling, lifetime and dispatch. The game owns every appearance input and
   may choose a completely different effect without changing this MCP package.

The event observer advances the real mixer or `AnimationPlayer`, compares the current time against
the measured row, dispatches once, and records the dispatch. It must also record the clip name,
current frame count and attachment bone. A successful check has exactly one dispatch at contact and
a non-zero particle count afterward.

## Failure rules

- A nonexistent clip name is a hard failure; do not silently select the nearest action.
- A missing event table is a hard failure; no timeout fallback is allowed.
- A second dispatch for the same clip/event is a hard failure.
- An attachment that cannot resolve the named bone is a hard failure.
- A screenshot can show that an effect is visible, but it cannot replace the event and dispatch
  observations.

The game authors the look in generated `src/render/` source. This resource supplies only the
measured-event contract and runtime vocabulary.

## Evidence boundary

The MCP measures and validates evidence. ThreeNative runs the animation, attachment and particle
mechanisms. The browser or native playtest records frame advancement and dispatch; Blender supplies
an independent rig and pose check. None of those hosts is a dependency of the published sculpt-MCP
runtime.

Adapted from img2threejs v1.5.2's measured-event VFX guidance at tag
`d6815db757c1eb435ae55f91fb375a7a98ddf28b`.
