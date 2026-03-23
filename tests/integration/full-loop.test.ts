import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../../src/orchestrator.js";
import { SessionManager } from "../../src/session.js";
import type { AgentAdapter } from "../../src/adapters/agent-adapter.js";
import type { AgentResponse, ConversationContext, OrchestratorConfig } from "../../src/types.js";
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

describe("Full collaboration loop", () => {
  const config: OrchestratorConfig = {
    startWith: "claude",
    workingDirectory: "/tmp",
    guardrailRounds: 6,
    timeoutMs: 120000,
    outputFormat: "text",
    codex: {
      sandboxMode: "workspace-write",
      webSearchMode: "live",
      networkAccessEnabled: true,
      approvalPolicy: "never",
    },
  };

  it("should run a full debate that converges via soft consensus (agree + partial)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-int-"));
    const session = new SessionManager(tmpDir);

    const claude = createScriptedAdapter("claude", [
      { content: "I propose a REST API with Express.\n[CONVERGENCE: partial]", convergenceSignal: "partial" },
      { content: "Good point about type safety. REST API with Express + Zod validation.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
      // Synthesis step response
      { content: "## API Layer Design\n\nUse a REST API built with Express and Zod for input validation." },
    ]);

    const codex = createScriptedAdapter("codex", [
      { content: "REST is fine, but add input validation with Zod.\n[CONVERGENCE: partial]", convergenceSignal: "partial" },
      { content: "I agree, Express + Zod is the right approach.\n[CONVERGENCE: agree]", convergenceSignal: "agree" },
    ]);

    const orch = new Orchestrator(claude, codex, session, config);
    const result = await orch.run("Design the API layer");

    // Turn-aware convergence: soft consensus (agree + partial) is blocked at turn 3,
    // so the debate continues to turn 4 where both agents signal agree (strong consensus).
    expect(result.type).toBe("consensus");
    expect(result.rounds).toBe(4);
    // Summary comes from synthesis step — contains the actual deliverable
    expect(result.summary).toContain("REST API");
    expect(result.summary).toContain("Zod");
    // 4 debate turns + 1 consensus message from synthesis
    expect(result.messages).toHaveLength(5);
    expect(result.messages[4].type).toBe("consensus");

    // Verify session files were created
    const dirs = fs.readdirSync(tmpDir);
    expect(dirs.length).toBe(1);

    const sessionDir = path.join(tmpDir, dirs[0]);
    expect(fs.existsSync(path.join(sessionDir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "transcript.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "summary.md"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should escalate and produce a disagreement report", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-int-"));
    const session = new SessionManager(tmpDir);

    const claude = createScriptedAdapter("claude", [
      { content: "Use GraphQL.\n[CONVERGENCE: disagree]", convergenceSignal: "disagree" },
      // Escalation response:
      { content: "## What we agree on\n- Need an API\n## Where we disagree\n- I prefer GraphQL\n## My recommendation\n- GraphQL", convergenceSignal: "disagree" },
    ]);

    const codex = createScriptedAdapter("codex", [
      { content: "Use REST.\n[CONVERGENCE: disagree]", convergenceSignal: "disagree" },
      // Escalation response:
      { content: "## What we agree on\n- Need an API\n## Where we disagree\n- I prefer REST\n## My recommendation\n- REST", convergenceSignal: "disagree" },
    ]);

    const smallConfig = { ...config, guardrailRounds: 3 };
    const orch = new Orchestrator(claude, codex, session, smallConfig);
    const result = await orch.run("Design the API layer");

    expect(result.type).toBe("escalation");
    expect(result.summary).toContain("[ESCALATION");
    expect(result.summary).toContain("Claude");
    expect(result.summary).toContain("Codex");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
