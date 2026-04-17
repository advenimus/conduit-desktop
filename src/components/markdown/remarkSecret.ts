import { visit, SKIP } from "unist-util-visit";
import type { Plugin } from "unified";
import type { Text, Parent } from "mdast";

const SECRET_RE = /!!(.+?)!!/g;

const remarkSecret: Plugin = () => {
  return (tree) => {
    visit(tree, "text", (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (index === undefined || !parent) return;

      const value = node.value;
      SECRET_RE.lastIndex = 0;

      const matches: { start: number; end: number; secret: string }[] = [];
      let match: RegExpExecArray | null;
      while ((match = SECRET_RE.exec(value)) !== null) {
        matches.push({ start: match.index, end: match.index + match[0].length, secret: match[1] });
      }

      if (matches.length === 0) return;

      const nodes: (Text | { type: string; data: Record<string, unknown>; children: Text[] })[] = [];
      let lastEnd = 0;

      for (const m of matches) {
        if (m.start > lastEnd) {
          nodes.push({ type: "text", value: value.slice(lastEnd, m.start) } as Text);
        }
        nodes.push({
          type: "secret",
          data: {
            hName: "span",
            hProperties: { className: "conduit-secret", "data-secret": m.secret },
          },
          children: [{ type: "text", value: m.secret } as Text],
        });
        lastEnd = m.end;
      }

      if (lastEnd < value.length) {
        nodes.push({ type: "text", value: value.slice(lastEnd) } as Text);
      }

      parent.children.splice(index, 1, ...(nodes as unknown as Text[]));
      return [SKIP, index + nodes.length] as const;
    });
  };
};

export default remarkSecret;
