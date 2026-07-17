// Shared Claude API plumbing used by both Stage 2 extraction
// (pipeline/extractInsights.ts) and Stage 5 Q&A (qa/askQuestion.ts) — a
// lazily-created client singleton, the shared model env var, and the
// forced-tool-use response unwrapping both call sites need identically.

import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "./env";

let client: Anthropic | null = null;

/** Lazily-created Anthropic client, shared across all callers in this process. */
export function getClaudeClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return client;
}

/** Model id for all Claude calls — overridable via CLAUDE_MODEL for testing
 * against a different model without a code change. */
export function getClaudeModel(): string {
  return process.env.CLAUDE_MODEL || "claude-sonnet-5";
}

/**
 * Pulls the tool_use block out of a forced-tool-use response and returns its
 * (untyped) input. Throws if Claude didn't return one — that would mean the
 * API itself misbehaved despite `tool_choice` forcing it, since a normal
 * error is surfaced as a rejected promise before this ever runs.
 */
export function getToolUseInput(message: Anthropic.Message, toolName: string): unknown {
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error(`Claude did not return a tool_use block for ${toolName}.`);
  }
  return toolUse.input;
}

/**
 * Single-user-message, forced-tool-use call — the shape shared by every
 * one-shot grounded call (askQuestion.ts, personSummary.ts): send a system
 * prompt + one user message, force the given tool, unwrap its input as T.
 * Multi-step/retrying callers (extractInsights.ts) build their own
 * messages.create call instead, since they need more control than this.
 */
export async function callToolOnce<T>(
  system: string,
  tool: Anthropic.Tool,
  userContent: string
): Promise<T> {
  const message = await getClaudeClient().messages.create({
    model: getClaudeModel(),
    max_tokens: 1024,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: userContent }],
  });
  return getToolUseInput(message, tool.name) as T;
}
