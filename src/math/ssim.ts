function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function structuralSimilarity(first: readonly number[], second: readonly number[]): number {
  if (first.length === 0 || first.length !== second.length) return 0;
  const firstMean = mean(first);
  const secondMean = mean(second);
  const firstVariance = mean(first.map((value) => (value - firstMean) ** 2));
  const secondVariance = mean(second.map((value) => (value - secondMean) ** 2));
  const covariance = mean(
    first.map((value, index) => (value - firstMean) * (second[index]! - secondMean))
  );
  const c1 = 0.01 ** 2;
  const c2 = 0.03 ** 2;
  const value =
    ((2 * firstMean * secondMean + c1) * (2 * covariance + c2)) /
    ((firstMean ** 2 + secondMean ** 2 + c1) *
      (firstVariance + secondVariance + c2));
  return Math.max(0, Math.min(1, value));
}

