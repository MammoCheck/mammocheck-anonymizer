// Browser ImageIO (works in a Web Worker): createImageBitmap + OffscreenCanvas.
import type { ImageIO } from "./process/image";

export const browserIO: ImageIO = {
  async decode(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    return { width: d.width, height: d.height, data: d.data };
  },
  async encode(b, format) {
    const c = new OffscreenCanvas(b.width, b.height);
    const g = c.getContext("2d")!;
    g.putImageData(new ImageData(new Uint8ClampedArray(b.data), b.width, b.height), 0, 0);
    const blob = await c.convertToBlob({ type: format === "png" ? "image/png" : "image/jpeg", quality: 0.92 });
    return new Uint8Array(await blob.arrayBuffer());
  },
};
