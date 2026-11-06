import { readFileSync, writeFileSync } from "node:fs";
import gifenc from "gifenc";
import { PNG } from "pngjs";
import { CliError } from "./errors.js";

interface Bitmap {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const stepDelayMilliseconds = 1500;
const maximumGifBytes = 10 * 1024 * 1024;
const maximumColors = 256;
const candidateWidths = [1280, 960, 720, 480];
// About 50x faster than the default on busy images, and fine for UI screenshots.
const colorFormat = "rgb444";

function decodeScreenshot(path: string): Bitmap {
  try {
    const image = PNG.sync.read(readFileSync(path));
    return { width: image.width, height: image.height, rgba: image.data };
  } catch (cause) {
    throw new CliError("screenshot_invalid", `${path} is not a readable PNG: ${String(cause)}`);
  }
}

/** Averages the source pixels behind one canvas pixel, which keeps small text legible. */
function averageSourceBlock(
  source: Bitmap,
  startX: number,
  endX: number,
  startY: number,
  endY: number,
  target: Uint8Array,
  targetOffset: number,
): void {
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * source.width + x) * 4;
      red += source.rgba[offset]!;
      green += source.rgba[offset + 1]!;
      blue += source.rgba[offset + 2]!;
    }
  }
  const pixelCount = (endX - startX) * (endY - startY);
  target[targetOffset] = red / pixelCount;
  target[targetOffset + 1] = green / pixelCount;
  target[targetOffset + 2] = blue / pixelCount;
  target[targetOffset + 3] = 255;
}

/** Fits the image inside the canvas, centred on white, keeping its proportions. */
function fitToCanvas(source: Bitmap, canvasWidth: number, canvasHeight: number): Bitmap {
  const scale = Math.min(canvasWidth / source.width, canvasHeight / source.height);
  const fittedWidth = Math.max(1, Math.round(source.width * scale));
  const fittedHeight = Math.max(1, Math.round(source.height * scale));
  const leftMargin = Math.floor((canvasWidth - fittedWidth) / 2);
  const topMargin = Math.floor((canvasHeight - fittedHeight) / 2);
  const rgba = new Uint8Array(canvasWidth * canvasHeight * 4).fill(255);

  for (let y = 0; y < fittedHeight; y += 1) {
    const startY = Math.floor((y * source.height) / fittedHeight);
    const endY = Math.max(startY + 1, Math.floor(((y + 1) * source.height) / fittedHeight));
    for (let x = 0; x < fittedWidth; x += 1) {
      const startX = Math.floor((x * source.width) / fittedWidth);
      const endX = Math.max(startX + 1, Math.floor(((x + 1) * source.width) / fittedWidth));
      const targetOffset = ((y + topMargin) * canvasWidth + x + leftMargin) * 4;
      averageSourceBlock(source, startX, endX, startY, endY, rgba, targetOffset);
    }
  }
  return { width: canvasWidth, height: canvasHeight, rgba };
}

function encodeGif(frames: Bitmap[], width: number, height: number): Uint8Array {
  const encoder = gifenc.GIFEncoder();
  for (const frame of frames) {
    const { rgba } = fitToCanvas(frame, width, height);
    const palette = gifenc.quantize(rgba, maximumColors, { format: colorFormat });
    encoder.writeFrame(gifenc.applyPalette(rgba, palette, colorFormat), width, height, {
      palette,
      delay: stepDelayMilliseconds,
      repeat: 0,
    });
  }
  encoder.finish();
  return encoder.bytes();
}

/** Every second frame, always keeping the last so the final state is shown. */
function dropEverySecondFrame(frames: Bitmap[]): Bitmap[] {
  const kept = frames.filter((_frame, index) => index % 2 === 0);
  const lastFrame = frames.at(-1)!;
  return kept.at(-1) === lastFrame ? kept : [...kept, lastFrame];
}

/**
 * Writes the GIF, shrinking it until it fits GitHub's image limit: first by
 * width, then by dropping steps.
 */
export function buildGif(screenshotPaths: string[], outputPath: string): void {
  let frames = screenshotPaths.map(decodeScreenshot);
  const fullWidth = Math.max(...frames.map((frame) => frame.width));
  const fullHeight = Math.max(...frames.map((frame) => frame.height));
  const widths = [...new Set(candidateWidths.map((width) => Math.min(width, fullWidth)))];

  for (;;) {
    for (const width of widths) {
      const height = Math.max(1, Math.round((fullHeight * width) / fullWidth));
      const bytes = encodeGif(frames, width, height);
      if (bytes.length <= maximumGifBytes) {
        writeFileSync(outputPath, bytes);
        return;
      }
    }
    if (frames.length <= 2) {
      throw new CliError("gif_too_large", "The GIF could not be kept under the 10 MiB limit.");
    }
    frames = dropEverySecondFrame(frames);
  }
}
