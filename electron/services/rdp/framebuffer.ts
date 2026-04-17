/**
 * RDP frame buffer management.
 *
 * Stores the current desktop image as RGBA pixels and provides
 * region updates, image encoding (PNG/JPEG via sharp), and extraction.
 *
 * Port of crates/conduit-rdp/src/framebuffer.rs
 */

import sharp from 'sharp';

export type ImageFormat = { type: 'png' } | { type: 'jpeg'; quality: number };

export class FrameBuffer {
  private width: number;
  private height: number;
  /** RGBA pixel data (4 bytes per pixel) */
  private pixels: Buffer;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 4);
  }

  /** Get frame buffer dimensions */
  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Get the raw RGBA pixel data */
  getPixels(): Buffer {
    return this.pixels;
  }

  /** Clear the frame buffer to black */
  clear(): void {
    this.pixels.fill(0);
  }

  /**
   * Update a rectangular region from BGRA bitmap data.
   *
   * Converts BGRA -> RGBA while copying. This matches the format
   * produced by node-rdpjs-2 bitmap events at 32 bpp.
   */
  updateRegionBgra(
    x: number,
    y: number,
    width: number,
    height: number,
    data: Buffer | Uint8Array | Uint8ClampedArray,
    srcStride: number,
  ): void {
    const dstStride = this.width * 4;

    for (let row = 0; row < height; row++) {
      const srcRowStart = row * srcStride;
      const dstY = y + row;

      if (dstY >= this.height) break;

      for (let col = 0; col < width; col++) {
        const dstX = x + col;
        if (dstX >= this.width) continue;

        const srcIdx = srcRowStart + col * 4;
        const dstIdx = dstY * dstStride + dstX * 4;

        if (srcIdx + 3 < data.length && dstIdx + 3 < this.pixels.length) {
          // BGRA -> RGBA
          this.pixels[dstIdx] = data[srcIdx + 2];     // R
          this.pixels[dstIdx + 1] = data[srcIdx + 1]; // G
          this.pixels[dstIdx + 2] = data[srcIdx];     // B
          this.pixels[dstIdx + 3] = 255;               // A
        }
      }
    }
  }

  /**
   * Update a rectangular region with RGBA data directly (no conversion).
   *
   * Used when bitmap data is already in RGBA format or has been decompressed.
   */
  updateRegionRgba(
    x: number,
    y: number,
    width: number,
    height: number,
    data: Buffer | Uint8Array | Uint8ClampedArray,
    srcStride: number,
  ): void {
    // Skip regions entirely outside the framebuffer
    if (x >= this.width || y >= this.height) return;

    const dstStride = this.width * 4;

    for (let row = 0; row < height; row++) {
      const srcRowStart = row * srcStride;
      const dstY = y + row;

      if (dstY >= this.height) break;

      const dstStart = dstY * dstStride + x * 4;
      const copyWidth = Math.min(
        width * 4,
        (this.width - x) * 4,
        srcStride,
      );

      // Guard against negative or zero copy width
      if (copyWidth <= 0) continue;

      if (
        dstStart + copyWidth <= this.pixels.length &&
        srcRowStart + copyWidth <= data.length
      ) {
        (data as Buffer).copy
          ? (data as Buffer).copy(this.pixels, dstStart, srcRowStart, srcRowStart + copyWidth)
          : this.pixels.set(
              (data as Uint8Array).subarray(srcRowStart, srcRowStart + copyWidth),
              dstStart,
            );
      }
    }
  }

  /**
   * Update region from a node-rdpjs-2 bitmap event.
   *
   * Handles both 32-bit and 16-bit color depths from the RDP bitmap update.
   * For decompressed data (Uint8ClampedArray from node-rdpjs-2), the pixel
   * format is RGBA and can be copied directly.
   */
  updateFromBitmap(bitmap: {
    destLeft: number;
    destTop: number;
    destRight: number;
    destBottom: number;
    width: number;
    height: number;
    bitsPerPixel: number;
    isCompress: boolean;
    data: Buffer | Uint8ClampedArray;
  }): void {
    const x = bitmap.destLeft;
    const y = bitmap.destTop;
    const w = bitmap.width;
    const h = bitmap.height;
    const stride = w * 4;

    if (bitmap.data instanceof Uint8ClampedArray || !bitmap.isCompress) {
      // Decompressed data from node-rdpjs-2 is in BGRA format
      if (bitmap.bitsPerPixel === 32) {
        this.updateRegionBgra(x, y, w, h, bitmap.data, stride);
      } else {
        // For 16-bit or other depths after decompression, data is already RGBA
        this.updateRegionRgba(x, y, w, h, bitmap.data, stride);
      }
    } else {
      // Raw compressed data — should have been decompressed first
      // node-rdpjs-2 handles decompression when config.decompress = true
      this.updateRegionBgra(x, y, w, h, bitmap.data, stride);
    }
  }

  /** Get reference to raw RGBA pixel data (eliminates full frame copy) */
  toRgba(): Buffer {
    return this.pixels;  // ✅ Return reference, not copy
  }

  /** Clone the raw RGBA pixel data (for screenshots where copy is needed) */
  toRgbaClone(): Buffer {
    return Buffer.from(this.pixels);
  }

  /** Encode the full frame buffer to PNG or JPEG using sharp */
  async encode(format: ImageFormat, maxWidth?: number): Promise<{ buffer: Buffer; width: number; height: number }> {
    let outputWidth = this.width;
    let outputHeight = this.height;

    // Clone for sharp to avoid mutation during encoding
    let img = sharp(this.toRgbaClone(), {
      raw: { width: this.width, height: this.height, channels: 4 },
    });

    if (maxWidth && this.width > maxWidth) {
      const scale = maxWidth / this.width;
      outputWidth = maxWidth;
      outputHeight = Math.round(this.height * scale);
      img = img.resize({ width: maxWidth, withoutEnlargement: true });
    }

    const buffer = format.type === 'png'
      ? await img.png().toBuffer()
      : await img.jpeg({ quality: format.quality }).toBuffer();

    return { buffer, width: outputWidth, height: outputHeight };
  }

  /**
   * Extract a raw RGBA region from the framebuffer.
   * Used for region merging optimization.
   */
  extractRegionRaw(x: number, y: number, width: number, height: number): Buffer {
    const regionSize = width * height * 4;
    const region = Buffer.allocUnsafe(regionSize);

    for (let row = 0; row < height; row++) {
      const srcOffset = ((y + row) * this.width + x) * 4;
      const dstOffset = row * width * 4;
      const copyLen = width * 4;
      this.pixels.copy(region, dstOffset, srcOffset, srcOffset + copyLen);
    }

    return region;
  }

  /** Extract a sub-region and encode it */
  async extractRegion(
    x: number,
    y: number,
    width: number,
    height: number,
    format: ImageFormat,
    maxWidth?: number,
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    // Clamp to frame buffer bounds
    const cx = Math.min(x, this.width);
    const cy = Math.min(y, this.height);
    const cw = Math.min(width, this.width - cx);
    const ch = Math.min(height, this.height - cy);

    let outputWidth = cw;
    let outputHeight = ch;

    const regionPixels = Buffer.alloc(cw * ch * 4);
    const srcStride = this.width * 4;
    const dstStride = cw * 4;

    for (let row = 0; row < ch; row++) {
      const srcStart = (cy + row) * srcStride + cx * 4;
      const dstStart = row * dstStride;
      this.pixels.copy(regionPixels, dstStart, srcStart, srcStart + dstStride);
    }

    let img = sharp(regionPixels, {
      raw: { width: cw, height: ch, channels: 4 },
    });

    if (maxWidth && cw > maxWidth) {
      const scale = maxWidth / cw;
      outputWidth = maxWidth;
      outputHeight = Math.round(ch * scale);
      img = img.resize({ width: maxWidth, withoutEnlargement: true });
    }

    const buffer = format.type === 'png'
      ? await img.png().toBuffer()
      : await img.jpeg({ quality: format.quality }).toBuffer();

    return { buffer, width: outputWidth, height: outputHeight };
  }

  /** Resize the frame buffer (clears existing data) */
  resize(width: number, height: number): void {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.pixels = Buffer.alloc(width * height * 4);
    }
  }
}
