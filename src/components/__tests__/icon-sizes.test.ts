// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Spec 5.5: icons render at these sizes only. Custom entry icons (iconRegistry.ts and what
// getEntryIcon returns) and EngineLogo keep their own sizes.
const ALLOWED_SIZES: ReadonlySet<number> = new Set([12, 16, 20, 24, 32, 48]);
const EXEMPT_TAGS: ReadonlySet<string> = new Set(["EngineLogo"]);
const ENTRY_ICON_FACTORIES: ReadonlySet<string> = new Set(["getEntryIcon"]);
const EXEMPT_FILES: ReadonlySet<string> = new Set(["entries/iconRegistry.ts"]);

const COMPONENTS = path.resolve(__dirname, "..");

interface Finding {
  file: string;
  line: number;
  tag: string;
  size: number;
}

/** Names bound to a getEntryIcon(...) result anywhere in the file. */
function entryIconNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      ENTRY_ICON_FACTORIES.has(node.initializer.expression.text)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function numericLiterals(node: ts.Node): number[] {
  if (ts.isNumericLiteral(node)) return [Number(node.text)];
  const found: number[] = [];
  ts.forEachChild(node, (child) => {
    found.push(...numericLiterals(child));
  });
  return found;
}

function iconSizeFindings(source: string, file: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const entryIcons = entryIconNames(sf);
  const findings: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "size" && node.initializer && ts.isJsxExpression(node.initializer)) {
      const element = node.parent.parent;
      const tag = ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element) ? element.tagName.getText(sf) : "";
      if (!EXEMPT_TAGS.has(tag) && !entryIcons.has(tag) && node.initializer.expression) {
        for (const size of numericLiterals(node.initializer.expression)) {
          if (!ALLOWED_SIZES.has(size)) {
            findings.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, tag, size });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("icon sizes (spec 5.5)", () => {
  it("reports sizes outside 12, 16, 20, 24, 32 and 48, and leaves entry icons and EngineLogo alone", () => {
    const source = `
      const A = () => {
        const Entry = getEntryIcon("ssh");
        return (
          <>
            <KeyIcon size={14} />
            <KeyIcon size={16} />
            <IconSlot icon="key" size={compact ? 13 : 20} />
            <EngineLogo type="claude-code" size={18} />
            <Entry size={18} />
            <Button size="sm" />
          </>
        );
      };
    `;
    expect(iconSizeFindings(source, "x/Sample.tsx").map((f) => `${f.tag}:${f.size}`)).toEqual(["KeyIcon:14", "IconSlot:13"]);
  });

  it("finds no other literal size under src/components", () => {
    const findings = sourceFiles(COMPONENTS)
      .map((full) => path.relative(COMPONENTS, full).split(path.sep).join("/"))
      .filter((rel) => !EXEMPT_FILES.has(rel))
      .flatMap((rel) => iconSizeFindings(fs.readFileSync(path.join(COMPONENTS, rel), "utf8"), rel));
    expect(findings.map((f) => `${f.file}:${f.line} <${f.tag} size={${f.size}}>`)).toEqual([]);
  });
});
