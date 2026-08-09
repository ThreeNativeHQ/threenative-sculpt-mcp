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

