// @vitest-environment node
// CLAUDE.md/AGENTS.md list tools from TOOL_REGISTRY, while agents call the MCP server's own definitions.
// The two lists must name the same tools.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY } from '../tool-registry.js';

const TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'mcp', 'src', 'tools');

function mcpToolNames(): string[] {
  const names = new Set<string>();
  for (const file of fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf-8');
    for (const m of text.matchAll(/^ {4}name: '([a-z_]+)',$/gm)) names.add(m[1]);
  }
  return [...names].sort();
}

describe('tool registry', () => {
  it('names every MCP tool and nothing else', () => {
    expect(TOOL_REGISTRY.map((t) => t.name).sort()).toEqual(mcpToolNames());
  });
});
