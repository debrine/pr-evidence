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

export function writeResults(directory: string, results: unknown): string {
  const path = join(directory, "results.json");
  writeFileSync(path, JSON.stringify(results));
  return path;
}
