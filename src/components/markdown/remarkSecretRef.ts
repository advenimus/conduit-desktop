import { visit, SKIP } from "unist-util-visit";
import type { Plugin } from "unified";
import type { Text, Parent } from "mdast";
import { parseRefs } from "../../lib/kb";

/** Turns {{secret:...}} and {{cred:...}} refs in text into chip spans (docs/KNOWLEDGE_BASE.md 2). */
const remarkSecretRef: Plugin = () => {
  return (tree) => {
    visit(tree, "text", (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (index === undefined || !parent) return;
      const refs = parseRefs(node.value);
      if (refs.length === 0) return;

      const nodes: unknown[] = [];
      let last = 0;
      for (const ref of refs) {
        if (ref.start > last) nodes.push({ type: "text", value: node.value.slice(last, ref.start) });
        nodes.push({
          type: "secretRef",
          data: {
            hName: "span",
            hProperties: {
              className: "conduit-secret-ref",
              "data-ref-kind": ref.kind,
              "data-ref-id": ref.id,
              "data-ref-label": ref.label ?? "",
              "data-ref-field": ref.field ?? "",
              "data-ref-pending": ref.pending ? "1" : "",
            },
          },
          children: [{ type: "text", value: ref.label ?? "secret" }],
        });
        last = ref.end;
      }
      if (last < node.value.length) nodes.push({ type: "text", value: node.value.slice(last) });

      parent.children.splice(index, 1, ...(nodes as Text[]));
      return [SKIP, index + nodes.length] as const;
    });
  };
};

export default remarkSecretRef;
