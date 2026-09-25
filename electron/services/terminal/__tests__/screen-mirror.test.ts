// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { ScreenMirror } from '../screen-mirror.js';

describe('ScreenMirror', () => {
  let mirror: ScreenMirror;

  afterEach(() => mirror.dispose());

  it('renders plain text without escape codes and stops at the cursor', async () => {
    mirror = new ScreenMirror(40, 10);
    mirror.write('\x1b[1;31merror:\x1b[0m bad\r\n$ ');
    const snap = await mirror.snapshot(50);
    expect(snap.lines).toEqual(['error: bad', '$']);
    expect(snap.alternateScreen).toBe(false);
  });

  it('joins lines that wrapped at the terminal width', async () => {
    mirror = new ScreenMirror(10, 5);
    mirror.write('0123456789abcdefghij-end\r\nnext');
    const snap = await mirror.snapshot(50);
    expect(snap.lines).toEqual(['0123456789abcdefghij-end', 'next']);
  });

  it('applies redraws the way the user sees them', async () => {
    mirror = new ScreenMirror(40, 5);
    mirror.write('progress 10%\rprogress 99%\r\x1b[Kdone\r\nabc\b\bXY');
    const snap = await mirror.snapshot(50);
    expect(snap.lines).toEqual(['done', 'aXY']);
  });

  it('returns only the requested number of trailing lines, with the total', async () => {
    mirror = new ScreenMirror(20, 5);
    for (let i = 1; i <= 30; i++) mirror.write(`line ${i}\r\n`);
    const snap = await mirror.snapshot(3);
    expect(snap.lines).toEqual(['line 29', 'line 30', '']);
    expect(snap.totalLines).toBe(31);
  });

  it('detects full-screen programs and bracketed paste mode', async () => {
    mirror = new ScreenMirror(20, 5);
    mirror.write('\x1b[?2004h$ ');
    await mirror.flush();
    expect(mirror.bracketedPasteMode).toBe(true);
    expect(mirror.alternateScreen).toBe(false);

    mirror.write('\x1b[?1049h\x1b[HTOP SCREEN');
    const snap = await mirror.snapshot(50);
    expect(mirror.alternateScreen).toBe(true);
    expect(snap.alternateScreen).toBe(true);
    expect(snap.lines[0]).toBe('TOP SCREEN');

    mirror.write('\x1b[?1049l\x1b[?2004l');
    await mirror.flush();
    expect(mirror.alternateScreen).toBe(false);
    expect(mirror.bracketedPasteMode).toBe(false);
  });

  it('follows resizes', async () => {
    mirror = new ScreenMirror(10, 5);
    mirror.resize(30, 5);
    mirror.write('0123456789abcdefghij');
    const snap = await mirror.snapshot(5);
    expect(snap.lines).toEqual(['0123456789abcdefghij']);
  });

  it('is safe to use after dispose', async () => {
    mirror = new ScreenMirror();
    mirror.dispose();
    mirror.write('ignored');
    mirror.resize(100, 40);
    await expect(mirror.snapshot(10)).resolves.toEqual({ lines: [], totalLines: 0, alternateScreen: false });
  });
});
