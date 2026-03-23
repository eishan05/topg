import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeAdapter } from "../../src/adapters/claude-adapter.js";
import type { ConversationContext } from "../../src/types.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// Mock child_process
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

function mockProcess(stdout: string): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.stdin = null as any;

  setTimeout(() => {
    (proc.stdout as EventEmitter).emit("data", Buffer.from(stdout));
    (proc.stdout as EventEmitter).emit("end");
    proc.emit("close", 0);
  }, 10);

  return proc;
}

describe("ClaudeAdapter", () => {
  const ctx: ConversationContext = {
    sessionId: "test-123",
    history: [],
    workingDirectory: "/tmp",
    systemPrompt: "You are a reviewer.",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should send a prompt and parse the response", async () => {
    // stream-json format: NDJSON with content_block_delta and result events
    const lines = [
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here is my review.\n" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[CONVERGENCE: agree]" } }),
      JSON.stringify({ type: "result", subtype: "success", result: "Here is my review.\n[CONVERGENCE: agree]" }),
    ].join("\n") + "\n";
    vi.mocked(spawn).mockReturnValue(mockProcess(lines));

    const adapter = new ClaudeAdapter();
    const result = await adapter.send("Review this code", ctx);

    expect(result.content).toContain("Here is my review");
    expect(result.convergenceSignal).toBe("agree");
  });

  it("should have name 'claude'", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.name).toBe("claude");
  });

  it("should abort when signal is triggered", async () => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.stdin = null as any;
    proc.kill = vi.fn();

    vi.mocked(spawn).mockReturnValue(proc);

    const controller = new AbortController();
    const adapter = new ClaudeAdapter();
    const promise = adapter.send("test prompt", ctx, controller.signal);

    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toThrow("aborted");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
