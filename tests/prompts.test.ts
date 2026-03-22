import { describe, it, expect } from "vitest";
import {
  initiatorPrompt,
  reviewerPrompt,
  rebuttalPrompt,
  escalationPrompt,
  userGuidancePrompt,
  formatConversationHistory,
  formatTurnPrompt,
  summarizeHistory,
} from "../src/prompts.js";
import type { Message } from "../src/types.js";

const makeMsg = (
  agent: "claude" | "codex",
  turn: number,
  content: string,
  signal?: "agree" | "disagree" | "partial"
): Message => ({
  role: turn % 2 === 1 ? "initiator" : "reviewer",
  agent,
  turn,
  type: "review",
  content,
  convergenceSignal: signal,
  timestamp: new Date().toISOString(),
});

describe("initiatorPrompt", () => {
  it("should include reasoning preamble", () => {
    const prompt = initiatorPrompt("codex");
    expect(prompt).toContain("Your understanding of the request");
    expect(prompt).toContain("Key constraints or assumptions");
    expect(prompt).toContain("Your chosen approach and why");
  });

  it("should reference the other agent", () => {
    const prompt = initiatorPrompt("codex");
    expect(prompt).toContain("codex");
  });

  it("should include trivial-request fast-path", () => {
    const prompt = initiatorPrompt("codex");
    expect(prompt).toContain("simple requests");
    expect(prompt).toContain("[CONVERGENCE: agree]");
  });
});

describe("reviewerPrompt", () => {
  it("should include verification checklist", () => {
    const prompt = reviewerPrompt("claude");
    expect(prompt).toContain("Correctness");
    expect(prompt).toContain("Completeness");
    expect(prompt).toContain("Quality");
  });

  it("should include surgical output instruction", () => {
    const prompt = reviewerPrompt("claude");
    expect(prompt).toContain("surgical");
    expect(prompt).toContain("Do not rewrite the entire response");
  });
});

describe("rebuttalPrompt", () => {
  it("should include balanced defense instructions", () => {
    const prompt = rebuttalPrompt("codex");
    expect(prompt).toContain("If valid: incorporate");
    expect(prompt).toContain("If partially valid");
    expect(prompt).toContain("If invalid: defend");
  });

  it("should warn against capitulating to converge", () => {
    const prompt = rebuttalPrompt("codex");
    expect(prompt).toContain("Do not accept changes that make the solution worse");
  });

  it("should include surgical output instruction", () => {
    const prompt = rebuttalPrompt("codex");
    expect(prompt).toContain("surgical");
  });
});

describe("escalationPrompt", () => {
  it("should require structured summary", () => {
    const prompt = escalationPrompt();
    expect(prompt).toContain("What we agree on");
    expect(prompt).toContain("Where we disagree");
    expect(prompt).toContain("My recommendation");
  });
});

describe("userGuidancePrompt", () => {
  it("should prioritize user direction", () => {
    const prompt = userGuidancePrompt("codex");
    expect(prompt).toContain("user's direction takes priority");
  });
});

describe("formatConversationHistory", () => {
  it("should return empty string for no messages", () => {
    expect(formatConversationHistory([])).toBe("");
  });

  it("should use XML-style turn delimiters", () => {
    const messages: Message[] = [
      makeMsg("claude", 1, "Hello world"),
    ];
    const history = formatConversationHistory(messages);
    expect(history).toContain('<turn number="1" agent="claude" role="initiator">');
    expect(history).toContain("Hello world");
    expect(history).toContain("</turn>");
  });

  it("should escape </turn> in message content", () => {
    const messages: Message[] = [
      makeMsg("claude", 1, "Here is some XML: </turn> and more text"),
    ];
    const history = formatConversationHistory(messages);
    // The literal </turn> in content should be escaped
    expect(history).not.toContain("</turn> and more text");
    expect(history).toContain("&lt;/turn&gt; and more text");
    // The structural closing tag should still be there
    expect(history).toContain("</turn>\n\n");
  });

  it("should include agent and role attributes", () => {
    const messages: Message[] = [
      makeMsg("claude", 1, "First"),
      makeMsg("codex", 2, "Second"),
    ];
    const history = formatConversationHistory(messages);
    expect(history).toContain('agent="claude"');
    expect(history).toContain('agent="codex"');
    expect(history).toContain('role="initiator"');
    expect(history).toContain('role="reviewer"');
  });
});

describe("summarizeHistory", () => {
  it("should return all messages as recent when below threshold", () => {
    const messages = [makeMsg("claude", 1, "Hello"), makeMsg("codex", 2, "Hi")];
    const { summary, recent } = summarizeHistory(messages);
    expect(summary).toBe("");
    expect(recent).toEqual(messages);
  });

  it("should split messages when above keepRecent", () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      makeMsg(i % 2 === 0 ? "claude" : "codex", i + 1, `Turn ${i + 1} content`)
    );
    const { summary, recent } = summarizeHistory(messages, 4);
    expect(recent).toHaveLength(4);
    expect(recent[0].turn).toBe(3);
    expect(summary).toContain("2 earlier turns");
  });

  it("should include agreement signals in summary", () => {
    const messages = [
      makeMsg("claude", 1, "Proposal A", "partial"),
      makeMsg("codex", 2, "Counter B", "partial"),
      makeMsg("claude", 3, "Revised A", "agree"),
      makeMsg("codex", 4, "Agree now", "agree"),
      makeMsg("claude", 5, "Final"),
      makeMsg("codex", 6, "Done"),
    ];
    // keepRecent=2 means last 2 (turns 5,6) are recent, turns 1-4 are summarized
    const { summary } = summarizeHistory(messages, 2);
    expect(summary).toContain("Claude signaled agree");
    expect(summary).toContain("Codex signaled agree");
  });

  it("should not attribute user guidance as an agent position", () => {
    const messages: Message[] = [
      makeMsg("claude", 1, "Use React"),
      makeMsg("codex", 2, "Use Vue"),
      {
        role: "initiator",
        agent: "claude",
        turn: 3,
        type: "user-prompt",
        content: "[USER GUIDANCE]: Use Svelte instead",
        timestamp: new Date().toISOString(),
      },
      makeMsg("codex", 4, "OK Svelte"),
      makeMsg("claude", 5, "Agreed"),
      makeMsg("codex", 6, "Done"),
    ];
    const { summary } = summarizeHistory(messages, 2);
    // User guidance should appear as user guidance, not as Claude's position
    expect(summary).toContain("User guidance");
    expect(summary).toContain("Use Svelte instead");
    // Claude's last real position should be "Use React", not the guidance
    expect(summary).toMatch(/Last position from Claude.*Use React/);
  });

  it("should not attribute user-prompt messages as agent positions", () => {
    const messages: Message[] = [
      makeMsg("claude", 1, "Response A"),
      makeMsg("codex", 2, "Response B"),
      {
        role: "initiator",
        agent: "claude",
        turn: 3,
        type: "user-prompt",
        content: "[USER PROMPT #2]: New question here",
        timestamp: new Date().toISOString(),
      },
      makeMsg("codex", 4, "Answer"),
      makeMsg("claude", 5, "Final"),
      makeMsg("codex", 6, "Done"),
    ];
    const { summary } = summarizeHistory(messages, 2);
    expect(summary).toContain("User said");
    expect(summary).toMatch(/Last position from Claude.*Response A/);
  });

  it("should include last positions per agent", () => {
    const messages = [
      makeMsg("claude", 1, "Use React for the frontend"),
      makeMsg("codex", 2, "Use Vue instead"),
      makeMsg("claude", 3, "OK maybe Next.js"),
      makeMsg("codex", 4, "Agreed"),
      makeMsg("claude", 5, "Final"),
    ];
    const { summary } = summarizeHistory(messages, 2);
    expect(summary).toContain("Last position from Claude");
    expect(summary).toContain("Last position from Codex");
  });
});

describe("formatTurnPrompt", () => {
  it("should include system prompt at the start", () => {
    const result = formatTurnPrompt("System instructions here", []);
    expect(result.startsWith("System instructions here")).toBe(true);
  });

  it("should include user prompt when provided", () => {
    const result = formatTurnPrompt("sys", [], "Build a REST API");
    expect(result).toContain("## User's Original Request");
    expect(result).toContain("Build a REST API");
  });

  it("should place convergence instruction after ## Your Response", () => {
    const result = formatTurnPrompt("sys", []);
    const responseIdx = result.indexOf("## Your Response");
    const convergenceIdx = result.indexOf("[CONVERGENCE: agree|disagree|partial]");
    expect(responseIdx).toBeGreaterThan(-1);
    expect(convergenceIdx).toBeGreaterThan(responseIdx);
  });

  it("should use full history for small conversations", () => {
    const messages = [makeMsg("claude", 1, "Hello"), makeMsg("codex", 2, "Hi")];
    const result = formatTurnPrompt("sys", messages);
    expect(result).toContain("## Conversation So Far");
    expect(result).not.toContain("Earlier Discussion");
  });

  it("should summarize history for long conversations", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 2 === 0 ? "claude" : "codex", i + 1, `Turn ${i + 1} content`)
    );
    const result = formatTurnPrompt("sys", messages);
    expect(result).toContain("Earlier Discussion (summarized)");
    expect(result).toContain("## Recent Turns");
  });
});
