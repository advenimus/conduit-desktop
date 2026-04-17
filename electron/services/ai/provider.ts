/**
 * AI provider interface and shared types.
 *
 * Port of crates/conduit-ai/src/provider.rs and crates/conduit-ai/src/types.rs
 */

import { BrowserWindow } from 'electron';

// ── Types ────────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<Record<string, unknown>> };

export interface Message {
  role: MessageRole;
  content: ContentBlock[];
}

export interface StreamEvent {
  type: 'text_delta' | 'tool_use' | 'input_json_delta' | 'done' | 'error' | 'usage';
  content?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  message?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ── Provider interface ───────────────────────────────────────────────────────

export interface AiProvider {
  complete(messages: Message[], system?: string, signal?: AbortSignal): Promise<Message>;

  completeStream(
    messages: Message[],
    system: string | undefined,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;

  setTools(tools: ToolDefinition[]): void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

export function messageText(msg: Message): string {
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
