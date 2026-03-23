import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { SessionManager } from "../src/session.js";
import type { AgentAdapter } from "../src/adapters/agent-adapter.js";
import type { AgentResponse, Message, OrchestratorConfig } from "../src/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function createScriptedAdapter(name: "claude" | "codex", script: AgentResponse[]): AgentAdapter {
  let i = 0;
  return {
    name,
    send: vi.fn(async () => {
      const resp = script[i] ?? script[script.length - 1];
      i++;
      return resp;
    }),
  };
}

describe("Orchestrator callbacks", () => {
  const config: OrchestratorConfig = {
    startWith: "claude",
    workingDirectory: "/tmp",
    guardrailRounds: 6,
    timeoutMs: 120000,
    outputFormat: "text",
  };

  it("should call onTurnComplete for each message appended during a debate", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-cb-"));
    const session = new SessionManager(tmpDir);
    const completedMessages: Message[] = [];

    const claude = createScriptedAdapter("claude", [
      { content: "I propose X.\n[CONVERGENCE: partial]", convergenceSignal: "partial" },
      { content: "Agreed with Y.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const codex = createScriptedAdapter("codex", [
      { content: "X is fine, but add Y.\n[CONVERGENCE: partial]", convergenceSignal: "partial" },
      { content: "Agreed.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const orch = new Orchestrator(claude, codex, session, config, {
      onTurnComplete: (msg) => completedMessages.push(msg),
    });

    const result = await orch.run("Test prompt");

    // Should have called onTurnComplete for each message
    expect(completedMessages.length).toBe(result.messages.length);

    // Each completed message should match the messages in the result
    for (let i = 0; i < completedMessages.length; i++) {
      expect(completedMessages[i].content).toBe(result.messages[i].content);
      expect(completedMessages[i].agent).toBe(result.messages[i].agent);
      expect(completedMessages[i].turn).toBe(result.messages[i].turn);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should still support onTurnStart via the callbacks object", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-cb-"));
    const session = new SessionManager(tmpDir);
    const turnStarts: Array<{ turn: number; agent: string; role: string }> = [];

    const claude = createScriptedAdapter("claude", [
      { content: "Proposal.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const codex = createScriptedAdapter("codex", [
      { content: "Agreed.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const orch = new Orchestrator(claude, codex, session, config, {
      onTurnStart: (turn, agent, role) => turnStarts.push({ turn, agent, role }),
    });

    await orch.run("Test prompt");

    // onTurnStart should have been called at least for the initiator and reviewer
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);
    expect(turnStarts[0]).toEqual({ turn: 1, agent: "claude", role: "initiator" });
    expect(turnStarts[1]).toEqual({ turn: 2, agent: "codex", role: "reviewer" });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should call both onTurnStart and onTurnComplete together", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-cb-"));
    const session = new SessionManager(tmpDir);
    const events: string[] = [];

    const claude = createScriptedAdapter("claude", [
      { content: "Proposal.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const codex = createScriptedAdapter("codex", [
      { content: "Agreed.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const orch = new Orchestrator(claude, codex, session, config, {
      onTurnStart: (turn, agent, role) => events.push(`start:${turn}:${agent}`),
      onTurnComplete: (msg) => events.push(`complete:${msg.turn}:${msg.agent}`),
    });

    await orch.run("Test prompt");

    // Each turn should have start before complete
    expect(events[0]).toBe("start:1:claude");
    expect(events[1]).toBe("complete:1:claude");
    expect(events[2]).toBe("start:2:codex");
    expect(events[3]).toBe("complete:2:codex");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
