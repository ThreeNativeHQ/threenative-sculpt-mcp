const EPSILON = 1e-6;
const WEIGHT_TOLERANCE = 1e-4;
const MAX_INFLUENCES = 4;

type JsonRecord = Record<string, unknown>;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function vector3(value: unknown, label: string, errors: string[]): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) {
    errors.push(`${label} must be a finite length-3 vector`);
    return undefined;
  }
  return [...value] as number[];
}

function matrix16(value: unknown, label: string, errors: string[]): number[] | undefined {
  let flat: number[] | undefined;
  if (Array.isArray(value) && value.length === 16 && value.every(finite)) flat = [...value] as number[];
  else if (Array.isArray(value) && value.length === 4 && value.every((row) => Array.isArray(row) && row.length === 4)) {
    const values = value.flat();
    if (values.every(finite)) flat = values as number[];
    else errors.push(`${label} must contain only finite numbers`);
  }
  if (!flat) {
    errors.push(`${label} must be a finite 4x4 matrix or flat length-16 matrix`);
    return undefined;
  }
  if (flat.slice(12, 16).some((actual, index) => Math.abs(actual - [0, 0, 0, 1][index]!) > WEIGHT_TOLERANCE)) errors.push(`${label} must have affine last row [0, 0, 0, 1]`);
  const scales = [0, 1, 2].map((column) => Math.hypot(flat![column]!, flat![4 + column]!, flat![8 + column]!));
  if (scales.some((scale) => scale <= EPSILON)) errors.push(`${label} contains a zero-scale basis column`);
  return flat;
}

export function validateRigPayload(payload: unknown): JsonRecord {
  const errors: string[] = [], warnings: string[] = [];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { schemaVersion: 1, passed: false, errors: ["payload root must be an object"], warnings, summary: { jointCount: 0, vertexCount: 0, maxInfluences: MAX_INFLUENCES, activeVertexCountByJoint: [] }, evidenceBoundary: "structural payload only" };
  const value = payload as JsonRecord;
  const allowed = new Set(["schemaVersion", "coordinateSystem", "joints", "parents", "names", "matrix_local", "skinIndex", "skinWeight"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`unknown field: ${key}`);
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  const coordinate = value.coordinateSystem;
  if (typeof coordinate !== "object" || coordinate === null || Array.isArray(coordinate)) errors.push("coordinateSystem is required");
  else {
    const frame = coordinate as JsonRecord;
    if (frame.up !== "Y") errors.push("coordinateSystem.up must be Y");
    if (frame.handedness !== "right") errors.push("coordinateSystem.handedness must be right");
    if (typeof frame.unit !== "string" || !frame.unit) errors.push("coordinateSystem.unit must be a non-empty string");
  }
  const rawJoints = value.joints;
  const joints: number[][] = [];
  if (!Array.isArray(rawJoints) || rawJoints.length === 0) errors.push("joints must be a non-empty list");
  else rawJoints.forEach((joint, index) => { const parsed = vector3(joint, `joints[${index}]`, errors); if (parsed) joints.push(parsed); });
  const jointCount = Array.isArray(rawJoints) ? rawJoints.length : 0;
  const parents = value.parents;
  const names = value.names;
  const matrices = value.matrix_local;
  if (!Array.isArray(parents) || parents.length !== jointCount) errors.push("parents must have one entry per joint");
  if (!Array.isArray(names) || names.length !== jointCount) errors.push("names must have one entry per joint");
  if (!Array.isArray(matrices) || matrices.length !== jointCount) errors.push("matrix_local must have one matrix per joint");
  const parentList = Array.isArray(parents) ? parents : [];
  const nameList = Array.isArray(names) ? names : [];
  const matrixList = Array.isArray(matrices) ? matrices : [];
  const seenNames = new Set<string>();
  nameList.forEach((name, index) => {
    if (typeof name !== "string" || !name.trim()) errors.push(`names[${index}] must be a non-empty string`);
    else if (seenNames.has(name)) errors.push(`duplicate joint name: ${name}`);
    if (typeof name === "string") seenNames.add(name);
  });
  if (parentList.length > 0 && parentList[0] !== null) errors.push("parents[0] must be null for the single root");
  const zeroLengthBones: Array<{ index: number; parent: number }> = [];
  parentList.slice(1).forEach((parent, offset) => {
    const index = offset + 1;
    if (!Number.isInteger(parent)) errors.push(`parents[${index}] must be an integer parent index`);
    else if ((parent as number) < 0 || (parent as number) >= index) errors.push(`parents[${index}] must satisfy 0 <= parent < child index`);
    else if (joints[index] && joints[parent as number] && Math.hypot(...joints[index]!.map((item, axis) => item - joints[parent as number]![axis]!)) <= EPSILON) zeroLengthBones.push({ index, parent: parent as number });
  });
  matrixList.forEach((matrix, index) => matrix16(matrix, `matrix_local[${index}]`, errors));
  const skinIndices = value.skinIndex;
  const skinWeights = value.skinWeight;
  if (!Array.isArray(skinIndices) || !Array.isArray(skinWeights)) errors.push("skinIndex and skinWeight are required packed arrays");
  const indexList = Array.isArray(skinIndices) ? skinIndices : [];
  const weightList = Array.isArray(skinWeights) ? skinWeights : [];
  if (indexList.length !== weightList.length) errors.push("skinIndex and skinWeight must have the same vertex count");
  const vertexCount = Math.min(indexList.length, weightList.length);
  const active = Array.from({ length: jointCount }, () => 0);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const indices = indexList[vertex], weights = weightList[vertex];
    if (!Array.isArray(indices) || indices.length !== MAX_INFLUENCES) { errors.push(`skinIndex[${vertex}] must have exactly ${MAX_INFLUENCES} slots`); continue; }
    if (!Array.isArray(weights) || weights.length !== MAX_INFLUENCES) { errors.push(`skinWeight[${vertex}] must have exactly ${MAX_INFLUENCES} slots`); continue; }
    indices.forEach((joint, slot) => { if (!Number.isInteger(joint) || (joint as number) < 0 || (joint as number) >= jointCount) errors.push(`skinIndex[${vertex}][${slot}] points outside the joint array`); else if (finite(weights[slot]) && (weights[slot] as number) > EPSILON) active[joint as number]! += 1; });
    if (!weights.every((weight) => finite(weight) && (weight as number) >= 0)) errors.push(`skinWeight[${vertex}] must contain finite non-negative values`);
    else {
      const total = (weights as number[]).reduce((sum, weight) => sum + weight, 0);
      if (Math.abs(total - 1) > WEIGHT_TOLERANCE) errors.push(`skinWeight[${vertex}] must sum to 1 (got ${total.toFixed(6)})`);
      if (total <= EPSILON) errors.push(`skinWeight[${vertex}] must influence at least one joint`);
    }
  }
  const unweighted = active.map((count, index) => count === 0 ? String(nameList[index] ?? index) : undefined).filter((name): name is string => name !== undefined);
  if (unweighted.length) warnings.push(`joints with no active vertex influence: ${unweighted.join(", ")}`);
  for (const { index, parent } of zeroLengthBones) {
    if (active[index]! > 0) errors.push(`joint ${index} has zero-length parent bone ${parent}`);
    else warnings.push(`joint ${index} has zero-length parent bone ${parent} but no active vertex influence; retained as a technical joint`);
  }
  return { schemaVersion: 1, passed: errors.length === 0, errors, warnings, summary: { jointCount, vertexCount, maxInfluences: MAX_INFLUENCES, activeVertexCountByJoint: active }, evidenceBoundary: "structural payload only; runtime deformation and screenshot gates are separate" };
}

export const validate = validateRigPayload;
