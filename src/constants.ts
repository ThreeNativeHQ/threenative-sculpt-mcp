export const PASS_ORDER = [
  "blockout",
  "structural-pass",
  "form-refinement",
  "material-pass",
  "surface-pass",
  "lighting-pass",
  "interaction-pass",
  "optimization-pass"
] as const;

export type PassId = (typeof PASS_ORDER)[number];

export const COMPLEXITY_THRESHOLDS = {
  simple: {
    macroComponents: 1,
    mesoComponents: 0,
    microFeatureGroups: 0,
    materialLayers: 1,
    repetitionSystems: 0,
    reviewViewpoints: 2,
    detailInventory: 3
  },
  moderate: {
    macroComponents: 2,
    mesoComponents: 3,
    microFeatureGroups: 2,
    materialLayers: 2,
    repetitionSystems: 0,
    reviewViewpoints: 3,
    detailInventory: 6
  },
  complex: {
    macroComponents: 3,
    mesoComponents: 8,
    microFeatureGroups: 5,
    materialLayers: 3,
    repetitionSystems: 1,
    reviewViewpoints: 4,
    detailInventory: 10
  },
  "ultra-complex": {
    macroComponents: 5,
    mesoComponents: 16,
    microFeatureGroups: 8,
    materialLayers: 4,
    repetitionSystems: 2,
    reviewViewpoints: 5,
    detailInventory: 16
  }
} as const;

export type ComplexityTier = keyof typeof COMPLEXITY_THRESHOLDS;

export const SCULPT_PROFILES = ["generic", "character", "animated-character"] as const;

export type SculptProfile = (typeof SCULPT_PROFILES)[number];

export const STAGE_R_STEPS = [
  {
    id: "rig-contract-read",
    description:
      "Read the animation contract and the complete character rigging and animation contract before authoring."
  },
  {
    id: "glb-rig-reference",
    description:
      "Read the skeleton, skin joint order, inverse binds, landmarks and clips from the GLB."
  },
  {
    id: "mesh-repair",
    description: "Inspect and repair mesh breakage before the geometry becomes evidence."
  },
  {
    id: "mesh-freeze",
    description: "Freeze packed mesh buffers before any rig work."
  },
  {
    id: "rig-payload-validate",
    description: "Validate the structural rig payload without substituting pose or likeness gates."
  },
  {
    id: "rig-bind",
    description: "Bind additively: add the skeleton and skin attributes while preserving frozen buffers."
  },
  {
    id: "mesh-parity-verify",
    description: "Verify post-bind packed buffers against the frozen manifest."
  },
  {
    id: "clip-measure",
    description: "Measure, classify, name and loop-decide every sampled clip from observed transforms."
  },
  {
    id: "rig-gates",
    description: "Run every Stage R gate; an unevaluated gate is not a pass."
  }
] as const;

export const ANIMATION_GRIMOIRE_TOPICS = [
  "readiness/animation_contract",
  "readiness/action_rigging",
  "readiness/joint_attachment",
  "readiness/standard_character_pipeline"
] as const;

export const BINDING_EPSILON = 2 ** -23;
export const BIND_RESTORE_TOLERANCE = 1e-12;
