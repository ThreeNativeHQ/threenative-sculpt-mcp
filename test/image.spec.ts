import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compareImages } from "../src/image.js";

async function gradientPng(file: string, offset = 0): Promise<void> {
  const width = 32;
  const height = 32;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = (x * 7 + offset) % 256;
      pixels[index + 1] = (y * 7 + offset) % 256;
      pixels[index + 2] = ((x + y) * 4 + offset) % 256;
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

describe("sculpt comparison", () => {
  it("returns per-region evidence for real captures", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sculpt-compare-"));
    const reference = path.join(directory, "reference.png");
    const capture = path.join(directory, "capture.png");
    await gradientPng(reference);
    await gradientPng(capture, 2);
    const result = await compareImages(reference, capture, [
      { id: "left", x: 0, y: 0, width: 0.5, height: 1 },
      { id: "right", x: 0.5, y: 0, width: 0.5, height: 1 }
    ]);
    expect(result).toMatchObject({ status: "evidence", authority: "diagnostic-only" });
    expect(result.regions.map((region) => region.id)).toEqual(["left", "right"]);
    expect(result.overall.score).toBeGreaterThan(0.8);
  });

  it("fails closed for a nonexistent capture", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sculpt-missing-"));
    const reference = path.join(directory, "reference.png");
    await gradientPng(reference);
    await expect(compareImages(reference, path.join(directory, "absent.png"), [])).rejects.toThrow(
      "capture image does not exist or is unreadable"
    );
  });

  it("fails closed for a zero-byte capture", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sculpt-zero-"));
    const reference = path.join(directory, "reference.png");
    const capture = path.join(directory, "capture.png");
    await gradientPng(reference);
    await writeFile(capture, "");
    await expect(compareImages(reference, capture, [])).rejects.toThrow(
      "capture image is zero bytes"
    );
  });

  it("fails closed for an all-one-colour capture", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sculpt-flat-"));
    const reference = path.join(directory, "reference.png");
    const capture = path.join(directory, "capture.png");
    await gradientPng(reference);
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#336699" } })
      .png()
      .toFile(capture);
    await expect(compareImages(reference, capture, [])).rejects.toThrow(
      "capture image is all one colour"
    );
  });

  it("fails closed for a decoded 1x1 solid PNG", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sculpt-one-pixel-"));
    const reference = path.join(directory, "reference.png");
    const capture = path.join(directory, "capture.png");
    await gradientPng(reference);
    await writeFile(
      capture,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
      )
    );
    await expect(compareImages(reference, capture, [])).rejects.toThrow(
      "capture image is all one colour"
    );
  });
});
