/**
 * Adapted from img2threejs forge/_shared/image_hash.py at
 * d6673386f89673a58736f8d398dd16ece67874f5.
 */

const matrixCache = new Map<number, number[][]>();

function dctMatrix(size: number): number[][] {
  const cached = matrixCache.get(size);
  if (cached) return cached;
  const factor = Math.PI / (2 * size);
  const matrix = Array.from({ length: size }, (_, k) => {
    const scale = k === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
    return Array.from({ length: size }, (_, index) =>
      scale * Math.cos((2 * index + 1) * k * factor)
    );
  });
  matrixCache.set(size, matrix);
  return matrix;
}

function dct2d(block: number[][]): number[][] {
  const size = block.length;
  const matrix = dctMatrix(size);
  const temp = Array.from({ length: size }, (_, k) =>
    Array.from({ length: size }, (_, column) =>
      matrix[k]!.reduce(
        (sum, coefficient, index) => sum + coefficient * block[index]![column]!,
        0
      )
    )
  );
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, l) =>
      temp[row]!.reduce(
        (sum, coefficient, index) => sum + coefficient * matrix[l]![index]!,
        0
      )
    )
  );
}

export function perceptualHash(gray: number[][], hashSize = 8): bigint {
  if (gray.length < hashSize || gray.some((row) => row.length !== gray.length)) {
    throw new Error(`grayscale image must be square and at least ${hashSize} pixels wide`);
  }
  const coefficients = dct2d(gray);
  const low = Array.from({ length: hashSize }, (_, y) =>
    Array.from({ length: hashSize }, (_, x) => coefficients[y]![x]!)
  ).flat();
  const ac = low.slice(1).map(Math.abs).sort((a, b) => a - b);
  const middle = Math.floor(ac.length / 2);
  const median =
    ac.length % 2 === 1 ? ac[middle]! : (ac[middle - 1]! + ac[middle]!) / 2;
  const noiseFloor = Math.max(...low.map(Math.abs)) * 1e-12;
  return low.reduce(
    (bits, value) => (bits << 1n) | (Math.abs(value) > median + noiseFloor ? 1n : 0n),
    0n
  );
}

export function hammingDistance(first: bigint, second: bigint): number {
  let difference = first ^ second;
  let count = 0;
  while (difference > 0n) {
    count += Number(difference & 1n);
    difference >>= 1n;
  }
  return count;
}

export function normalizedHashSimilarity(first: bigint, second: bigint, bits = 64): number {
  return 1 - hammingDistance(first, second) / bits;
}

