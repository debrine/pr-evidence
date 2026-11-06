import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

export function writeSolidPng(
  path: string,
  [red, green, blue]: [number, number, number],
  width = 40,
  height = 30,
): void {
  const image = new PNG({ width, height });
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    image.data.set([red, green, blue, 255], pixel * 4);
  }
  writeFileSync(path, PNG.sync.write(image));
}

/** Random pixels barely compress, which is the worst case for GIF size. */
export function writeNoisePng(path: string, width: number, height: number): void {
  const image = new PNG({ width, height });
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const value = () => Math.floor(Math.random() * 256);
    image.data.set([value(), value(), value(), 255], pixel * 4);
  }
  writeFileSync(path, PNG.sync.write(image, { deflateLevel: 1 }));
}

export function writeResults(directory: string, results: unknown): string {
  const path = join(directory, "results.json");
  writeFileSync(path, JSON.stringify(results));
  return path;
}
