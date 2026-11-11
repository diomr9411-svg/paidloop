import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { imageSize } from "../src/capture";
import { encodePng, jpegOrientation, photoPixels, Pixels, shrink, upright } from "../src/picture";

const photo = readFileSync(join(__dirname, "fixtures", "note-photo.jpg"));

/** The same photo with an EXIF note "turn me": phones store many photos sideways like this. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const exif = Buffer.from([
    0xff, 0xe1, 0x00, 0x22, ...Buffer.from("Exif\0\0", "latin1"),
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, first directory at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // orientation, one SHORT
    0x00, 0x00, 0x00, 0x00, // no next directory
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

/** A 3 x 2 grey picture: 1 2 3 / 4 5 6 */
const small: Pixels = { width: 3, height: 2, channels: 1, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) };

describe("getting a picture ready for reading", () => {
  it("a phone photo's turn is read from its EXIF", () => {
    expect(jpegOrientation(photo)).toBe(1);
    expect(jpegOrientation(withOrientation(photo, 6))).toBe(6);
    expect(jpegOrientation(withOrientation(photo, 8))).toBe(8);
    expect(jpegOrientation(Buffer.from([0xff, 0xd8, 0xff]))).toBe(1);
  });

  it("a JPEG is decoded, and a sideways one is turned upright", async () => {
    const plain = (await photoPixels(photo, "JPEG"))!;
    expect([plain.width, plain.height, plain.channels]).toEqual([960, 720, 3]);
    const turned = (await photoPixels(withOrientation(photo, 6), "JPEG"))!;
    expect([turned.width, turned.height]).toEqual([720, 960]);
  });

  it("a photo that sits further inside a memory block (as uploads can) is still decoded", async () => {
    const block = new Uint8Array(photo.length + 100);
    block.set(photo, 100);
    const pixels = await photoPixels(block.subarray(100), "JPEG");
    expect([pixels?.width, pixels?.height]).toEqual([960, 720]);
  });

  it("turning moves every pixel to the right place", () => {
    expect(Array.from(upright(small, 3).data)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(Array.from(upright(small, 6).data)).toEqual([4, 1, 5, 2, 6, 3]);
    expect(Array.from(upright(small, 8).data)).toEqual([3, 6, 2, 5, 1, 4]);
    expect(upright(small, 1)).toBe(small);
  });

  it("shrinking averages the pixels and keeps the shape", () => {
    const four: Pixels = { width: 4, height: 2, channels: 1, data: Uint8Array.from([0, 100, 200, 200, 0, 100, 200, 200]) };
    const half = shrink(four, 2);
    expect([half.width, half.height, Array.from(half.data)]).toEqual([2, 1, [50, 200]]);
    expect(shrink(four, 10)).toBe(four);
  });

  it("the result is a real PNG of the right size", () => {
    const png = encodePng({ width: 3, height: 2, channels: 3, data: new Uint8Array(18).fill(128) });
    expect(imageSize(png)).toEqual({ format: "PNG", width: 3, height: 2 });
  });
});
