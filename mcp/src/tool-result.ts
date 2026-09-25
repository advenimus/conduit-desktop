/**
 * Lets a tool return long multi-line text (command output, screen contents)
 * as its own MCP text block instead of a JSON-escaped string field, so agents
 * read newlines, quotes, and backslashes exactly as the terminal printed them.
 */

const TEXT_RESULT = Symbol('conduit.textResult');

export interface TextResult {
  readonly [TEXT_RESULT]: true;
  metadata: Record<string, unknown>;
  text: string;
}

export function textResult(metadata: Record<string, unknown>, text: string): TextResult {
  return { [TEXT_RESULT]: true, metadata, text };
}

export function isTextResult(value: unknown): value is TextResult {
  return typeof value === 'object' && value !== null && TEXT_RESULT in value;
}
