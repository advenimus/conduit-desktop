import { toPlainText } from './ansi.js';

export interface CapturedOutput {
  text: string;
  truncated: boolean;
  omittedLines: number;
}

/**
 * Keeps the first `headMax` and last `tailMax` characters of a stream so a
 * command that prints megabytes can't exhaust memory or flood the agent.
 */
export class OutputCapture {
  private head = '';
  private tail = '';
  private omittedChars = 0;
  private omittedLines = 0;

  constructor(
    private readonly headMax: number,
    private readonly tailMax: number,
  ) {}

  append(text: string): void {
    let rest = text;
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) return;
    this.tail += rest;
    if (this.tail.length > this.tailMax * 2) this.dropTail(this.tail.length - this.tailMax);
  }

  render(): CapturedOutput {
    if (this.tail.length > this.tailMax) this.dropTail(this.tail.length - this.tailMax);
    if (this.omittedChars === 0) {
      return { text: toPlainText(this.head + this.tail), truncated: false, omittedLines: 0 };
    }
    // Cut back to whole lines on both sides of the gap.
    const headEnd = this.head.lastIndexOf('\n') + 1 || this.head.length;
    const tailStart = this.tail.indexOf('\n') + 1;
    const omittedLines = this.omittedLines + (tailStart > 0 ? 1 : 0);
    const head = toPlainText(this.head.slice(0, headEnd)).replace(/\n$/, '');
    const tail = toPlainText(this.tail.slice(tailStart));
    return {
      text: `${head}\n[... ${omittedLines} lines omitted ...]\n${tail}`,
      truncated: true,
      omittedLines,
    };
  }

  private dropTail(count: number): void {
    const dropped = this.tail.slice(0, count);
    this.tail = this.tail.slice(count);
    this.omittedChars += dropped.length;
    this.omittedLines += dropped.split('\n').length - 1;
  }
}
