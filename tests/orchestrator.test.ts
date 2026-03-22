import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import type { AgentAdapter } from "../src/adapters/agent-adapter.js";
import type { AgentResponse, ConversationContext, OrchestratorConfig, Message } from "../src/types.js";
import { SessionManager } from "../src/session.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function createMockAdapter(name: "claude" | "codex", responses: AgentResponse[]): AgentAdapter {
  let callIndex = 0;
  return {
    name,
    send: vi.fn(async (_prompt: string, _ctx: ConversationContext) => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return response;
    }),
  };
}

const defaultConfig: OrchestratorConfig = {
  startWith: "claude",
  workingDirectory: "/tmp",
  guardrailRounds: 8,
  timeoutMs: 120000,
  outputFormat: "text",
};

describe("Orchestrator", () => {

  it("should reach consensus in 2 rounds when both agree immediately", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-orch-"));
    const session = new SessionManager(tmpDir);

    const claude = createMockAdapter("claude", [
      { content: "Use React.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);
    const codex = createMockAdapter("codex", [
      { content: "I agree, React is great.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const orch = new Orchestrator(claude, codex, session, defaultConfig);
    const result = await orch.run("What frontend framework?");

    expect(result.type).toBe("consensus");
    expect(result.rounds).toBeLessThanOrEqual(2);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should escalate after guardrail rounds when agents disagree", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-orch-"));
    const session = new SessionManager(tmpDir);

    const claude = createMockAdapter("claude", [
      { content: "Use React.\n[CONVERGENCE: disagree]", convergenceSignal: "disagree" },
    ]);
    const codex = createMockAdapter("codex", [
      { content: "Use Vue.\n[CONVERGENCE: disagree]", convergenceSignal: "disagree" },
    ]);

    const config = { ...defaultConfig, guardrailRounds: 3 };
    const orch = new Orchestrator(claude, codex, session, config);
    const result = await orch.run("What frontend framework?");

    expect(result.type).toBe("escalation");
    expect(result.rounds).toBe(3);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should converge mid-loop when agents reach agreement", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-orch-"));
    const session = new SessionManager(tmpDir);

    const claude = createMockAdapter("claude", [
      { content: "Use React.\n[CONVERGENCE: partial]", convergenceSignal: "partial" },
      { content: "OK, React with Next.js.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);
    const codex = createMockAdapter("codex", [
      { content: "React is fine but add Next.js.\n[CONVERGENCE: partial]", convergenceSignal: "partial" },
      { content: "Agreed, React + Next.js.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const orch = new Orchestrator(claude, codex, session, defaultConfig);
    const result = await orch.run("What frontend framework?");

    expect(result.type).toBe("consensus");
    expect(result.rounds).toBeGreaterThan(2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should preserve partial escalation when one agent fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-orch-"));
    const session = new SessionManager(tmpDir);

    // Claude succeeds, Codex fails on escalation call (4th call = escalation)
    let claudeCallCount = 0;
    const claude: AgentAdapter = {
      name: "claude",
      send: vi.fn(async () => {
        claudeCallCount++;
        return { content: "My escalation summary.\n[CONVERGENCE: disagree]", convergenceSignal: "disagree" as const };
      }),
    };

    let codexCallCount = 0;
    const codex: AgentAdapter = {
      name: "codex",
      send: vi.fn(async () => {
        codexCallCount++;
        // First call succeeds (review loop), second call (escalation) fails
        if (codexCallCount > 1) {
          throw new Error("Codex API timeout");
        }
        return { content: "Disagree.\n[CONVERGENCE: disagree]", convergenceSignal: "disagree" as const };
      }),
    };

    const config = { ...defaultConfig, guardrailRounds: 3 };
    const orch = new Orchestrator(claude, codex, session, config);
    const result = await orch.run("What frontend framework?");

    expect(result.type).toBe("escalation");
    // Claude's response should be preserved
    const claudeEsc = result.messages.find(m => m.type === "deadlock" && m.agent === "claude");
    expect(claudeEsc).toBeDefined();
    expect(claudeEsc!.content).toContain("My escalation summary");
    // Codex's failure should be captured, not lost
    const codexEsc = result.messages.find(m => m.type === "deadlock" && m.agent === "codex");
    expect(codexEsc).toBeDefined();
    expect(codexEsc!.content).toContain("Escalation failed");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("runWithHistory", () => {
  it("should start with existing messages and reach consensus", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-hist-"));
    const session = new SessionManager(tmpDir);

    const existingMessages: Message[] = [
      {
        role: "initiator",
        agent: "claude",
        turn: 1,
        type: "code",
        content: "Previous round response.",
        timestamp: new Date().toISOString(),
      },
    ];

    const claude = createMockAdapter("claude", [
      { content: "Building on prior context.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);
    const codex = createMockAdapter("codex", [
      { content: "I agree with this approach.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const config = { ...defaultConfig, guardrailRounds: 8 };
    const orch = new Orchestrator(claude, codex, session, config);

    const meta = session.create("test prompt", config);

    const result = await orch.runWithHistory(
      "New question",
      existingMessages,
      meta.sessionId
    );

    expect(result.type).toBe("consensus");
    expect(result.messages.length).toBeGreaterThan(existingMessages.length);
    expect(result.sessionId).toBe(meta.sessionId);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
