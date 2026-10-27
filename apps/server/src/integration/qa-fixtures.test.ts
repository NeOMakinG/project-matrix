import { join } from "node:path";
import { expect, test } from "vitest";
import { loadFixtures } from "./agent-qa-lane.js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..", "ops", "qa-lane", "fixtures");

/** EXIF IFD0 Orientation (0x0112) of a JPEG, or undefined when it has none. */
function orientation(jpeg: Buffer): number | undefined {
  let at = 2;
  while (at + 4 < jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    const size = jpeg.readUInt16BE(at + 2);
    if (marker === 0xe1 && jpeg.toString("latin1", at + 4, at + 10) === "Exif\0\0") {
      const tiff = at + 10;
      const le = jpeg.toString("latin1", tiff, tiff + 2) === "II";
      const u16 = (o: number) => (le ? jpeg.readUInt16LE(o) : jpeg.readUInt16BE(o));
      const u32 = (o: number) => (le ? jpeg.readUInt32LE(o) : jpeg.readUInt32BE(o));
      const ifd = tiff + u32(tiff + 4);
      for (let i = 0; i < u16(ifd); i++) {
        const entry = ifd + 2 + i * 12;
        if (u16(entry) === 0x0112) return u16(entry + 8);
      }
      return undefined;
    }
    at += 2 + size;
  }
  return undefined;
}

test("faceless-trip photos are upright JPEGs with camera EXIF (no Rotate 180 tag)", () => {
  const files = loadFixtures(ROOT, "faceless-trip");
  // 20 Porto (Feb 2025) + 2 Seville (Mar 2024): a film-eligible trip and one too short for a film.
  expect(files).toHaveLength(22);
  expect(files.filter((f) => f.name.startsWith("img_202502"))).toHaveLength(20);
  expect(files.filter((f) => f.name.startsWith("img_202403"))).toHaveLength(2);
  for (const { name, bytes } of files) {
    expect(bytes.subarray(0, 2).toString("hex"), name).toBe("ffd8");
    expect(orientation(bytes), name).toBe(1);
  }
});
