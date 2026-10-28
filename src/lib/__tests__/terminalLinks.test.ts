import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ILink } from "@xterm/xterm";

const { invoke, toastError } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../electron", () => ({ invoke }));
vi.mock("../../components/common/Toast", () => ({ toast: { error: toastError } }));

import { createPathLinkProvider, findPathLinks, openTerminalLink } from "../terminalLinks";

describe("findPathLinks", () => {
  const texts = (line: string) => findPathLinks(line).map((m) => m.text);

  it("finds absolute paths with at least two segments", () => {
    expect(texts("edited /Users/chris/app/src/main.ts today")).toEqual(["/Users/chris/app/src/main.ts"]);
  });

  it("finds home paths", () => {
    expect(texts("saved to ~/Downloads and ~/a/b.txt")).toEqual(["~/Downloads", "~/a/b.txt"]);
  });

  it("keeps :line and :line:col suffixes", () => {
    expect(texts("at /src/app/main.ts:42:7")).toEqual(["/src/app/main.ts:42:7"]);
  });

  it("drops trailing punctuation", () => {
    expect(texts("see (/var/log/system.log), or /var/log/other.log.")).toEqual([
      "/var/log/system.log",
      "/var/log/other.log",
    ]);
  });

  it("stops at quotes and brackets", () => {
    expect(texts(`open "/a/b/c.txt" and [/x/y/z]`)).toEqual(["/a/b/c.txt", "/x/y/z"]);
  });

  it("ignores slash commands and single-segment slashes", () => {
    expect(texts("/help /model /clear")).toEqual([]);
  });

  it("ignores relative paths and words joined by a slash", () => {
    expect(texts("src/app/main.ts and/or ./local/file")).toEqual([]);
  });

  it("does not match inside urls", () => {
    expect(texts("go to https://example.com/a/b/c and http://localhost:3000/x/y")).toEqual([]);
  });

  it("returns start and exclusive end offsets", () => {
    const line = "x /a/b/c y";
    const [match] = findPathLinks(line);
    expect(line.slice(match.start, match.end)).toBe("/a/b/c");
  });
});

describe("openTerminalLink", () => {
  beforeEach(() => {
    invoke.mockReset();
    toastError.mockReset();
  });

  it("asks the main process to open the target", async () => {
    invoke.mockResolvedValue(undefined);
    await openTerminalLink("https://example.com");
    expect(invoke).toHaveBeenCalledWith("open_target", { target: "https://example.com" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when opening fails", async () => {
    invoke.mockRejectedValue(new Error("Path does not exist: /a/b"));
    await openTerminalLink("/a/b");
    expect(toastError).toHaveBeenCalledWith("Couldn't open link", "Path does not exist: /a/b");
  });
});

function fakeTerminal(lines: Array<{ text: string; wrapped?: boolean }>, cols: number) {
  return {
    cols,
    buffer: {
      active: {
        getLine: (index: number) => {
          const line = lines[index];
          if (!line) return undefined;
          return {
            isWrapped: !!line.wrapped,
            translateToString: (trimRight?: boolean) => (trimRight ? line.text.trimEnd() : line.text),
          };
        },
      },
    },
  };
}

function provide(term: ReturnType<typeof fakeTerminal>, y: number, onOpen = vi.fn()) {
  let links: ILink[] | undefined;
  createPathLinkProvider(term as never, onOpen).provideLinks(y, (found) => {
    links = found;
  });
  return { links, onOpen };
}

describe("createPathLinkProvider", () => {
  it("returns a link with a 1-based inclusive range", () => {
    const term = fakeTerminal([{ text: "see /a/b/c now" }], 20);
    const { links } = provide(term, 1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe("/a/b/c");
    expect(links![0].range).toEqual({ start: { x: 5, y: 1 }, end: { x: 10, y: 1 } });
  });

  it("opens the matched text on activate", () => {
    const term = fakeTerminal([{ text: "/a/b/c" }], 20);
    const { links, onOpen } = provide(term, 1);
    links![0].activate(new MouseEvent("click"), links![0].text);
    expect(onOpen).toHaveBeenCalledWith("/a/b/c");
  });

  it("joins wrapped lines into one path", () => {
    const term = fakeTerminal(
      [{ text: "see /Users/chris/pro" }, { text: "jects/app/main.ts ok", wrapped: true }],
      20,
    );
    const first = provide(term, 1).links;
    const second = provide(term, 2).links;
    expect(first![0].text).toBe("/Users/chris/projects/app/main.ts");
    expect(first![0].range.start).toEqual({ x: 5, y: 1 });
    expect(first![0].range.end).toEqual({ x: 17, y: 2 });
    expect(second![0].text).toBe("/Users/chris/projects/app/main.ts");
  });

  it("returns nothing when the line has no paths", () => {
    const term = fakeTerminal([{ text: "nothing here" }], 20);
    expect(provide(term, 1).links).toBeUndefined();
  });
});
