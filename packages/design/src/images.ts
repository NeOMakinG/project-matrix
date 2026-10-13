import { createRequire } from "node:module";
import { screenshotHash } from "@matrix/core";

const require = createRequire(import.meta.url);
if (require("playwright-core/package.json").version !== "1.64.0")
  throw new Error("Design image engine requires pinned playwright-core 1.64.0");
interface Pixels {
  width: number;
  height: number;
  data: Buffer;
}
const { PNG, jpegjs } = require("playwright-core/lib/utilsBundle") as {
  PNG: {
    sync: {
      read(bytes: Buffer, options?: { checkCRC: boolean }): Pixels;
      write(image: Pixels): Buffer;
    };
  };
  jpegjs: {
    decode(
      bytes: Buffer,
      options: { maxMemoryUsageInMB: number; maxResolutionInMP: number; tolerantDecoding: boolean },
    ): Pixels;
  };
};
const { utils } = require("playwright-core/lib/coreBundle") as {
  utils: {
    getComparator(mime: "image/png"): (
      actual: Buffer,
      expected: Buffer,
      options: {
        comparator: "pixelmatch";
        threshold: number;
        maxDiffPixelRatio: number;
      },
    ) => null | { errorMessage: string; diff?: Buffer };
  };
};
export function decodePng(bytes: Uint8Array): Pixels {
  screenshotHash(bytes);
  const buffer = Buffer.from(bytes);
  if (buffer.readUInt32BE(16) * buffer.readUInt32BE(20) > 4_000_000)
    throw new Error("image pixel limit exceeded");
  const pixels = PNG.sync.read(buffer, { checkCRC: true });
  if (pixels.data.length !== pixels.width * pixels.height * 4)
    throw new Error("invalid decoded image");
  return pixels;
}
export function normalizeImage(bytes: Uint8Array): Buffer {
  if (!bytes.length || bytes.length > 16 * 1024 * 1024)
    throw new Error("image byte limit exceeded");
  if (Buffer.from(bytes.subarray(0, 8)).toString("hex") === "89504e470d0a1a0a") {
    decodePng(bytes);
    return Buffer.from(bytes);
  }
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error("unsupported image encoding");
  const pixels = jpegjs.decode(Buffer.from(bytes), {
    maxMemoryUsageInMB: 64,
    maxResolutionInMP: 4,
    tolerantDecoding: false,
  });
  const png = PNG.sync.write(pixels);
  decodePng(png);
  return png;
}
export function comparePixels(
  actual: Uint8Array,
  reference: Uint8Array,
  threshold: number,
  maxDiffPixelRatio: number,
) {
  const current = decodePng(actual);
  const expected = decodePng(reference);
  const result = utils.getComparator("image/png")(Buffer.from(actual), Buffer.from(reference), {
    comparator: "pixelmatch",
    threshold,
    maxDiffPixelRatio,
  });
  return {
    engine: "playwright-core@1.64.0/pixelmatch",
    matches: result === null,
    width: expected.width,
    height: expected.height,
    actualWidth: current.width,
    actualHeight: current.height,
    threshold,
    maxDiffPixelRatio,
    detail: result?.errorMessage ?? "pixels match",
    ...(result?.diff ? { diff: result.diff } : {}),
  };
}
export function encodePng(width: number, height: number, data: Buffer): Buffer {
  return PNG.sync.write({ width, height, data });
}
