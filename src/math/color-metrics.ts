/**
 * Adapted from img2threejs forge/_shared/color_metrics.py at
 * d6673386f89673a58736f8d398dd16ece67874f5.
 */

export type Lab = readonly [number, number, number];
export type Rgb = readonly [number, number, number];

const D65 = [95.047, 100, 108.883] as const;

function linearize(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function srgbToLab([red, green, blue]: Rgb): Lab {
  const r = linearize(red);
  const g = linearize(green);
  const b = linearize(blue);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) * 100;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) * 100;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) * 100;
  const transform = (value: number) =>
    value > 0.008856 ? value ** (1 / 3) : 7.787 * value + 16 / 116;
  const fx = transform(x / D65[0]);
  const fy = transform(y / D65[1]);
  const fz = transform(z / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function hueDegrees(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

export function ciede2000([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number {
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const cBar7 = cBar ** 7;
  const g = cBar > 0 ? 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7))) : 0;
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = hueDegrees(a1p, b1);
  const h2p = hueDegrees(a2p, b2);
  const deltaL = l2 - l1;
  const deltaC = c2p - c1p;
  const hueDifference = h2p - h1p;
  const deltaHue =
    c1p * c2p === 0
      ? 0
      : Math.abs(hueDifference) <= 180
        ? hueDifference
        : hueDifference > 180
          ? hueDifference - 360
          : hueDifference + 360;
  const deltaH = 2 * Math.sqrt(c1p * c2p) * Math.sin((deltaHue * Math.PI) / 360);
  const lBar = (l1 + l2) / 2;
  const cPrimeBar = (c1p + c2p) / 2;
  const hBar =
    c1p * c2p === 0
      ? h1p + h2p
      : Math.abs(h1p - h2p) <= 180
        ? (h1p + h2p) / 2
        : h1p + h2p < 360
          ? (h1p + h2p + 360) / 2
          : (h1p + h2p - 360) / 2;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const t =
    1 -
    0.17 * Math.cos(radians(hBar - 30)) +
    0.24 * Math.cos(radians(2 * hBar)) +
    0.32 * Math.cos(radians(3 * hBar + 6)) -
    0.2 * Math.cos(radians(4 * hBar - 63));
  const deltaTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const cPrimeBar7 = cPrimeBar ** 7;
  const rc = cPrimeBar > 0 ? 2 * Math.sqrt(cPrimeBar7 / (cPrimeBar7 + 25 ** 7)) : 0;
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cPrimeBar;
  const sh = 1 + 0.015 * cPrimeBar * t;
  const rt = -Math.sin(radians(2 * deltaTheta)) * rc;
  return Math.sqrt(
    (deltaL / sl) ** 2 +
      (deltaC / sc) ** 2 +
      (deltaH / sh) ** 2 +
      rt * (deltaC / sc) * (deltaH / sh)
  );
}

export function deltaERgb(first: Rgb, second: Rgb): number {
  return ciede2000(srgbToLab(first), srgbToLab(second));
}
