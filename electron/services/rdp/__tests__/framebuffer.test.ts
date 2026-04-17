import { describe, it, expect } from 'vitest';
import { FrameBuffer, type ImageFormat } from '../framebuffer.js';

describe('FrameBuffer', () => {
  it('creates a buffer with correct dimensions', () => {
    const fb = new FrameBuffer(100, 100);
    expect(fb.getDimensions()).toEqual({ width: 100, height: 100 });
    expect(fb.getPixels().length).toBe(100 * 100 * 4);
  });

  it('initializes all pixels to zero', () => {
    const fb = new FrameBuffer(10, 10);
    const pixels = fb.getPixels();
    for (let i = 0; i < pixels.length; i++) {
      expect(pixels[i]).toBe(0);
    }
  });

  it('clears the buffer to black', () => {
    const fb = new FrameBuffer(10, 10);
    const pixels = fb.getPixels();
    // Set some pixels to non-zero
    pixels[0] = 255;
    pixels[1] = 128;
    fb.clear();
    for (let i = 0; i < pixels.length; i++) {
      expect(pixels[i]).toBe(0);
    }
  });

  it('updates a region from BGRA data', () => {
    const fb = new FrameBuffer(100, 100);

    // Red pixel in BGRA format: B=0, G=0, R=255, A=255
    const redPixelBgra = Buffer.from([0, 0, 255, 255]);

    fb.updateRegionBgra(0, 0, 1, 1, redPixelBgra, 4);

    const pixels = fb.getPixels();
    expect(pixels[0]).toBe(255); // R
    expect(pixels[1]).toBe(0);   // G
    expect(pixels[2]).toBe(0);   // B
    expect(pixels[3]).toBe(255); // A
  });

  it('updates a region from RGBA data', () => {
    const fb = new FrameBuffer(100, 100);

    // Green pixel in RGBA format
    const greenPixelRgba = Buffer.from([0, 255, 0, 255]);

    fb.updateRegionRgba(5, 5, 1, 1, greenPixelRgba, 4);

    const idx = (5 * 100 + 5) * 4;
    const pixels = fb.getPixels();
    expect(pixels[idx]).toBe(0);     // R
    expect(pixels[idx + 1]).toBe(255); // G
    expect(pixels[idx + 2]).toBe(0);   // B
    expect(pixels[idx + 3]).toBe(255); // A
  });

  it('handles updateFromBitmap with 32-bit data', () => {
    const fb = new FrameBuffer(100, 100);

    // Simulate a 2x2 bitmap in BGRA (as node-rdpjs-2 provides after decompression)
    const bitmapData = Buffer.from([
      0, 0, 255, 255,   // Blue=0, Green=0, Red=255, Alpha=255 => Red pixel
      255, 0, 0, 255,   // Blue=255, Green=0, Red=0, Alpha=255 => Blue pixel
      0, 255, 0, 255,   // Blue=0, Green=255, Red=0, Alpha=255 => Green pixel
      255, 255, 255, 255 // White pixel
    ]);

    fb.updateFromBitmap({
      destLeft: 10,
      destTop: 20,
      destRight: 12,
      destBottom: 22,
      width: 2,
      height: 2,
      bitsPerPixel: 32,
      isCompress: false,
      data: bitmapData,
    });

    const pixels = fb.getPixels();
    // First pixel at (10, 20) should be red (BGRA->RGBA conversion)
    const idx1 = (20 * 100 + 10) * 4;
    expect(pixels[idx1]).toBe(255);     // R
    expect(pixels[idx1 + 1]).toBe(0);   // G
    expect(pixels[idx1 + 2]).toBe(0);   // B

    // Second pixel at (11, 20) should be blue
    const idx2 = (20 * 100 + 11) * 4;
    expect(pixels[idx2]).toBe(0);       // R
    expect(pixels[idx2 + 1]).toBe(0);   // G
    expect(pixels[idx2 + 2]).toBe(255); // B
  });

  it('clips updates that exceed bounds', () => {
    const fb = new FrameBuffer(10, 10);

    // A 5x5 update starting at (8, 8) — only 2x2 should fit
    const data = Buffer.alloc(5 * 5 * 4, 0xff);
    fb.updateRegionBgra(8, 8, 5, 5, data, 5 * 4);

    // Pixel at (9, 9) should be updated
    const idx = (9 * 10 + 9) * 4;
    expect(fb.getPixels()[idx + 3]).toBe(255); // Alpha set

    // No crash — the method handles out-of-bounds gracefully
  });

  it('toRgba returns a reference to pixel data', () => {
    const fb = new FrameBuffer(10, 10);
    const ref = fb.toRgba();
    ref[0] = 123;
    expect(fb.getPixels()[0]).toBe(123); // Same underlying buffer
  });

  it('toRgbaClone returns an independent copy', () => {
    const fb = new FrameBuffer(10, 10);
    const clone = fb.toRgbaClone();
    clone[0] = 123;
    expect(fb.getPixels()[0]).toBe(0); // Original unmodified
  });

  it('encodes to PNG format', async () => {
    const fb = new FrameBuffer(10, 10);

    // Fill with red
    const pixels = fb.getPixels();
    for (let i = 0; i < 100; i++) {
      pixels[i * 4] = 255;       // R
      pixels[i * 4 + 1] = 0;     // G
      pixels[i * 4 + 2] = 0;     // B
      pixels[i * 4 + 3] = 255;   // A
    }

    const pngResult = await fb.encode({ type: 'png' });
    const pngData = pngResult.buffer;

    // PNG signature: 137 80 78 71 13 10 26 10
    expect(pngData[0]).toBe(137);
    expect(pngData[1]).toBe(80);
    expect(pngData[2]).toBe(78);
    expect(pngData[3]).toBe(71);
    expect(pngData[4]).toBe(13);
    expect(pngData[5]).toBe(10);
    expect(pngData[6]).toBe(26);
    expect(pngData[7]).toBe(10);
  });

  it('encodes to JPEG format', async () => {
    const fb = new FrameBuffer(10, 10);

    const jpegResult = await fb.encode({ type: 'jpeg', quality: 85 });
    const jpegData = jpegResult.buffer;

    // JPEG signature: FF D8 (SOI marker)
    expect(jpegData[0]).toBe(0xff);
    expect(jpegData[1]).toBe(0xd8);
  });

  it('extracts a region and encodes to PNG', async () => {
    const fb = new FrameBuffer(100, 100);

    // Set pixel at (50, 50) to blue
    const idx = (50 * 100 + 50) * 4;
    const pixels = fb.getPixels();
    pixels[idx] = 0;       // R
    pixels[idx + 1] = 0;   // G
    pixels[idx + 2] = 255; // B
    pixels[idx + 3] = 255; // A

    const regionResult = await fb.extractRegion(45, 45, 20, 20, { type: 'png' });
    const regionPng = regionResult.buffer;

    // Should be a valid PNG
    expect(regionPng[0]).toBe(137); // PNG signature
    expect(regionPng[1]).toBe(80);
    expect(regionPng.length).toBeGreaterThan(8);
  });

  it('resizes the buffer', () => {
    const fb = new FrameBuffer(100, 100);
    expect(fb.getDimensions()).toEqual({ width: 100, height: 100 });

    fb.resize(200, 150);
    expect(fb.getDimensions()).toEqual({ width: 200, height: 150 });
    expect(fb.getPixels().length).toBe(200 * 150 * 4);
  });

  it('resize is a no-op when dimensions match', () => {
    const fb = new FrameBuffer(100, 100);
    const pixelsBefore = fb.getPixels();
    pixelsBefore[0] = 42;

    fb.resize(100, 100);
    // Same buffer reference — no reallocation
    expect(fb.getPixels()[0]).toBe(42);
  });
});
