import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { toast } from "../components/common/Toast";
import { invoke } from "./electron";

export interface PathLinkMatch {
  text: string;
  start: number;
  end: number;
}

// Two segments minimum for "/" paths, so slash commands like /help or /model stay plain text.
const PATH_PATTERN = /(?<![\w/:.~-])(?:~\/[^\s"'`<>()[\]{}]+|\/[^\s"'`<>()[\]{}/]+\/[^\s"'`<>()[\]{}]*)/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export function findPathLinks(lineText: string): PathLinkMatch[] {
  const matches: PathLinkMatch[] = [];
  for (const found of lineText.matchAll(PATH_PATTERN)) {
    const text = found[0].replace(TRAILING_PUNCTUATION, "");
    if (text.length < 2) continue;
    matches.push({ text, start: found.index, end: found.index + text.length });
  }
  return matches;
}

export async function openTerminalLink(target: string): Promise<void> {
  try {
    await invoke("open_target", { target });
  } catch (err) {
    toast.error("Couldn't open link", err instanceof Error ? err.message : String(err));
  }
}

export function createPathLinkProvider(
  term: Pick<Terminal, "buffer" | "cols">,
  onOpen: (target: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      let firstRow = bufferLineNumber - 1;
      while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow--;

      const parts: string[] = [];
      let row = firstRow;
      for (let line = buffer.getLine(row); line; line = buffer.getLine(row)) {
        const continues = !!buffer.getLine(row + 1)?.isWrapped;
        parts.push(line.translateToString(!continues));
        if (!continues) break;
        row++;
      }

      const toPosition = (offset: number) => ({
        x: (offset % term.cols) + 1,
        y: firstRow + 1 + Math.floor(offset / term.cols),
      });

      const links: ILink[] = findPathLinks(parts.join(""))
        .map((match) => ({
          text: match.text,
          range: { start: toPosition(match.start), end: toPosition(match.end - 1) },
          activate: (_event: MouseEvent, text: string) => onOpen(text),
        }))
        .filter((link) => link.range.start.y <= bufferLineNumber && bufferLineNumber <= link.range.end.y);

      callback(links.length ? links : undefined);
    },
  };
}
