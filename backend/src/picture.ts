// Gets a photo or a scanned page ready for reading: decoded, turned the right way up, and made smaller.
//
// A local vision model on a laptop processor needs about a minute for every 1,000 picture pieces (one piece
// is 32 x 32 pixels). A full-size phone photo has about 12,000, so it is made smaller first. pdf.js, which
// already reads PDFs here, decodes the pictures, so no extra package is needed.
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";

/** Raw pixels: 1 byte per pixel (grey) or 3 (red, green, blue), row after row. */
export interface Pixels {
  width: number;
  height: number;
  channels: 1 | 3;
  data: Uint8Array;
}

/** About 1,000 picture pieces for a 4:3 photo: enough for handwriting, about a minute on a laptop. */
export const AI_LONG_SIDE = 1280;
/** The basic reader likes bigger letters. */
export const OCR_LONG_SIDE = 2400;
/** Smaller pictures in a PDF are logos or QR codes, not a scanned page. */
export const SCAN_MIN_PIXELS = 400_000;
/** Bigger pictures would need too much memory to decode. */
const DECODE_MAX_PIXELS = 50_000_000;

// pdf.js ImageKind values
const GREY_1BIT = 1;
const RGB = 2;
const RGBA = 3;

type PdfPicture = { width: number; height: number; kind: number; data?: Uint8Array | Uint8ClampedArray };

/** The biggest picture on page 1 of a PDF, as pixels. null if there is none of at least `minPixels`. */
export async function biggestPicture(pdf: Uint8Array, minPixels = SCAN_MIN_PIXELS): Promise<Pixels | null> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isOffscreenCanvasSupported: false });
  const document = await loading.promise;
  try {
    const page = await document.getPage(1);
    const operations = await page.getOperatorList();
    let best: PdfPicture | null = null;
    for (let index = 0; index < operations.fnArray.length; index++) {
      const operation = operations.fnArray[index];
      let picture: PdfPicture | null = null;
      if (operation === pdfjs.OPS.paintImageXObject) {
        const name = operations.argsArray[index][0] as string;
        picture = await new Promise<PdfPicture>((resolve) => (page.objs.has(name) ? resolve(page.objs.get(name)) : page.objs.get(name, resolve)));
      } else if (operation === pdfjs.OPS.paintInlineImageXObject) {
        picture = operations.argsArray[index][0] as PdfPicture;
      }
      if (!picture?.data || picture.width * picture.height < minPixels || picture.width * picture.height > DECODE_MAX_PIXELS) continue;
      if (!best || picture.width * picture.height > best.width * best.height) best = picture;
    }
    return best ? toPixels(best) : null;
  } finally {
    await loading.destroy();
  }
}

function toPixels(picture: PdfPicture): Pixels | null {
  const { width, height, kind } = picture;
  const source = picture.data!;
  if (kind === RGB && source.length >= width * height * 3) return { width, height, channels: 3, data: Uint8Array.from(source.subarray(0, width * height * 3)) };
  if (kind === RGBA && source.length >= width * height * 4) {
    const data = new Uint8Array(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel++) data.set(source.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
    return { width, height, channels: 3, data };
  }
  if (kind === GREY_1BIT) {
    // Packed bits, each row padded to a whole byte; 1 is white
    const rowBytes = (width + 7) >> 3;
    if (source.length < rowBytes * height) return null;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) data[y * width + x] = source[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
    }
    return { width, height, channels: 1, data };
  }
  return null;
}

/** A JPEG or PNG photo as pixels. pdf.js decodes it once it sits in a one-page PDF. */
export async function photoPixels(photo: Uint8Array, format: "JPEG" | "PNG"): Promise<Pixels | null> {
  const document = await PDFDocument.create();
  const image = format === "JPEG" ? await document.embedJpg(photo) : await document.embedPng(photo);
  if (image.width * image.height > DECODE_MAX_PIXELS) return null;
  document.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  const pixels = await biggestPicture(await document.save(), 1);
  return pixels && format === "JPEG" ? upright(pixels, jpegOrientation(photo)) : pixels;
}

/** The EXIF orientation of a JPEG (1 = as stored). Phones often store a photo sideways and set this. */
export function jpegOrientation(jpeg: Uint8Array): number {
  const view = Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  let offset = 2;
  while (offset + 4 < view.length && view[offset] === 0xff) {
    const marker = view[offset + 1];
    const length = view.readUInt16BE(offset + 2);
    if (marker === 0xda) break; // the picture data starts; no EXIF before it
    if (marker === 0xe1 && view.toString("latin1", offset + 4, offset + 10) === "Exif\0\0") {
      const tiff = offset + 10;
      const little = view.toString("latin1", tiff, tiff + 2) === "II";
      const u16 = (at: number) => (little ? view.readUInt16LE(at) : view.readUInt16BE(at));
      const u32 = (at: number) => (little ? view.readUInt32LE(at) : view.readUInt32BE(at));
      if (tiff + 8 > view.length) return 1;
      const directory = tiff + u32(tiff + 4);
      if (directory + 2 > view.length) return 1;
      for (let entry = 0; entry < u16(directory); entry++) {
        const at = directory + 2 + entry * 12;
        if (at + 10 > view.length) return 1;
        if (u16(at) === 0x0112) return u16(at + 8);
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

/** Turns stored pixels the right way up. Mirrored orientations (rare on phones) are left as they are. */
export function upright(pixels: Pixels, orientation: number): Pixels {
  if (![3, 6, 8].includes(orientation)) return pixels;
  const { width, height, channels, data } = pixels;
  const turned = orientation !== 3;
  const out: Pixels = { width: turned ? height : width, height: turned ? width : height, channels, data: new Uint8Array(data.length) };
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      // Where this pixel was before turning
      const [fromX, fromY] = orientation === 3 ? [width - 1 - x, height - 1 - y] : orientation === 6 ? [y, height - 1 - x] : [width - 1 - y, x];
      const from = (fromY * width + fromX) * channels;
      out.data.set(data.subarray(from, from + channels), (y * out.width + x) * channels);
    }
  }
  return out;
}

/** Makes the long side at most `longSide`, averaging the pixels so thin pen lines stay visible. */
export function shrink(pixels: Pixels, longSide: number): Pixels {
  const { width, height, channels, data } = pixels;
  const scale = Math.max(width, height) / longSide;
  if (scale <= 1) return pixels;
  const outWidth = Math.max(1, Math.round(width / scale));
  const outHeight = Math.max(1, Math.round(height / scale));
  const out = new Uint8Array(outWidth * outHeight * channels);
  const sums = new Float64Array(channels);
  for (let y = 0; y < outHeight; y++) {
    const top = Math.floor((y * height) / outHeight);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * height) / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const left = Math.floor((x * width) / outWidth);
      const right = Math.max(left + 1, Math.floor(((x + 1) * width) / outWidth));
      sums.fill(0);
      for (let row = top; row < bottom; row++) {
        for (let column = left; column < right; column++) {
          const at = (row * width + column) * channels;
          for (let channel = 0; channel < channels; channel++) sums[channel] += data[at + channel];
        }
      }
      const count = (bottom - top) * (right - left);
      for (let channel = 0; channel < channels; channel++) out[(y * outWidth + x) * channels + channel] = Math.round(sums[channel] / count);
    }
  }
  return { width: outWidth, height: outHeight, channels, data: out };
}

function pngChunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

export function encodePng(pixels: Pixels): Buffer {
  const { width, height, channels, data } = pixels;
  const rowBytes = width * channels;
  const rows = Buffer.alloc((rowBytes + 1) * height); // each row starts with filter 0 (none)
  for (let row = 0; row < height; row++) rows.set(data.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, channels === 1 ? 0 : 2, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows, { level: 6 })), pngChunk("IEND", new Uint8Array())]);
}
