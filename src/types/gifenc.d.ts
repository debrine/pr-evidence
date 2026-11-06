declare module "gifenc" {
  type Palette = number[][];
  type ColorFormat = "rgb444" | "rgb565";

  interface GifEncoder {
    writeFrame(
      indexedPixels: Uint8Array,
      width: number,
      height: number,
      options: { palette: Palette; delay: number; repeat?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  const gifenc: {
    GIFEncoder(): GifEncoder;
    quantize(rgba: Uint8Array, maximumColors: number, options: { format: ColorFormat }): Palette;
    applyPalette(rgba: Uint8Array, palette: Palette, format: ColorFormat): Uint8Array;
  };
  export default gifenc;
}
