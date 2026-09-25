/**
 * Headless copy of what the user's terminal shows, so agents read the real
 * screen (full-screen apps, redrawn prompts, wrapped lines) instead of the raw
 * byte stream, and terminal_execute can see the shell's current modes.
 */

import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

const { Terminal } = headless;

export const MIRROR_SCROLLBACK = 2_000;

export interface ScreenSnapshot {
  lines: string[];
  totalLines: number;
  alternateScreen: boolean;
}

export class ScreenMirror {
  private readonly term: HeadlessTerminal;
  private disposed = false;

  constructor(cols = 80, rows = 24) {
    this.term = new Terminal({ cols, rows, scrollback: MIRROR_SCROLLBACK, allowProposedApi: true });
  }

  write(text: string): void {
    if (!this.disposed) this.term.write(text);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols > 0 && rows > 0 && (cols !== this.term.cols || rows !== this.term.rows)) {
      this.term.resize(cols, rows);
    }
  }

  /** Resolves once everything written so far has been parsed. */
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.term.write('', resolve));
  }

  get bracketedPasteMode(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  get alternateScreen(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  /** Last `maxLines` logical lines (wrapped rows joined), ending at the cursor or last text. */
  async snapshot(maxLines: number): Promise<ScreenSnapshot> {
    await this.flush();
    if (this.disposed) return { lines: [], totalLines: 0, alternateScreen: false };
    const buffer = this.term.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    let lastRow = cursorRow;
    for (let row = buffer.length - 1; row > cursorRow; row--) {
      if (buffer.getLine(row)?.translateToString(true)) {
        lastRow = row;
        break;
      }
    }

    const lines: string[] = [];
    for (let row = 0; row <= lastRow; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const continues = buffer.getLine(row + 1)?.isWrapped ?? false;
      const text = line.translateToString(!continues);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }

    return {
      lines: lines.slice(-Math.max(1, maxLines)).map((line) => line.trimEnd()),
      totalLines: lines.length,
      alternateScreen: buffer.type === 'alternate',
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.dispose();
  }
}
