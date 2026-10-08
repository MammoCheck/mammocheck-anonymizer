// ImageIO for Node (verification script only), backed by @napi-rs/canvas.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ImageIO } from "../src/process/image";

export const nodeIO: ImageIO = {
  async decode(bytes) {
    const img = await loadImage(Buffer.from(bytes));
    const c = createCanvas(img.width, img.height);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height);
    return { width: img.width, height: img.height, data: new Uint8ClampedArray(d.data) };
  },
  async encode(b, format) {
    const c = createCanvas(b.width, b.height);
    const g = c.getContext("2d");
    const d = g.createImageData(b.width, b.height);
    d.data.set(b.data);
    g.putImageData(d, 0, 0);
    const buf = format === "png" ? await c.encode("png") : await c.encode("jpeg", 92);
    return new Uint8Array(buf);
  },
};
