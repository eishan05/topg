import { describe, it, expect } from "vitest";
import type { Message, SessionMeta, OrchestratorConfig } from "../src/types.js";

describe("types", () => {
  it("should create a valid Message", () => {
    const msg: Message = {
      role: "initiator",
      agent: "claude",
      turn: 1,
      type: "code",
      content: "Here is my implementation...",
      convergenceSignal: "partial",
      timestamp: new Date().toISOString(),
    };
    expect(msg.agent).toBe("claude");
    expect(msg.turn).toBe(1);
  });

  it("should create a valid SessionMeta", () => {
    const meta: SessionMeta = {
      version: 1,
      sessionId: "test-123",
      status: "active",
      prompt: "Design auth system",
      config: {
        startWith: "claude",
        workingDirectory: "/tmp",
        guardrailRounds: 8,
        timeoutMs: 120000,
        outputFormat: "text",
        codex: {
          sandboxMode: "workspace-write",
          webSearchMode: "live",
          networkAccessEnabled: true,
          approvalPolicy: "never",
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(meta.version).toBe(1);
    expect(meta.config.guardrailRounds).toBe(8);
  });

  it("should allow user-prompt message type", () => {
    const msg: Message = {
      role: "initiator",
      agent: "claude",
      turn: 0,
      type: "user-prompt",
      content: "[USER PROMPT #1]: test",
      timestamp: new Date().toISOString(),
    };
    expect(msg.type).toBe("user-prompt");
  });
});
