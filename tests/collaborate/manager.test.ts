import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CollaborationManager } from "../../src/collaborate/manager.js";
import { SessionManager } from "../../src/core/session.js";
import type { AgentAdapter } from "../../src/core/adapters/agent-adapter.js";
import type { AgentResponse, ConversationContext } from "../../src/core/types.js";
import type { CollaborateConfig } from "../../src/collaborate/types.js";

function createMockAdapter(response: string): AgentAdapter {
  return {
    name: "codex",
    send: vi.fn().mockResolvedValue({
      content: response,
      artifacts: undefined,
      toolActivities: undefined,
      convergenceSignal: undefined,
    } satisfies AgentResponse),
  };
}

describe("CollaborationManager", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-collab-test-"));
    sessionManager = new SessionManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseConfig: CollaborateConfig = {
    with: "codex",
    workingDirectory: "/tmp",
    timeoutMs: 120000,
    outputFormat: "json",
    codex: {
      sandboxMode: "read-only",
      webSearchMode: "live",
      networkAccessEnabled: true,
      approvalPolicy: "never",
    },
  };

  describe("start", () => {
    it("should create a session and return the collaborator response", async () => {
      const adapter = createMockAdapter("I see a potential issue on line 42.");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      const result = await manager.start("Review my auth module");
      expect(result.sessionId).toBeTruthy();
      expect(result.agent).toBe("codex");
      expect(result.response).toBe("I see a potential issue on line 42.");
    });

    it("should persist the session as type collaborate", async () => {
      const adapter = createMockAdapter("Looks good.");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      const result = await manager.start("Check this");
      const loaded = sessionManager.load(result.sessionId);
      expect(loaded.meta.type).toBe("collaborate");
      expect(loaded.meta.agent).toBe("codex");
      expect(loaded.messages).toHaveLength(2);
    });

    it("should send the prompt to the adapter", async () => {
      const adapter = createMockAdapter("Response");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      await manager.start("Review this code");
      expect(adapter.send).toHaveBeenCalledTimes(1);
      const sentPrompt = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sentPrompt).toContain("Review this code");
    });
  });

  describe("send", () => {
    it("should send a follow-up message and return response", async () => {
      const adapter = createMockAdapter("Initial review done.");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      const { sessionId } = await manager.start("Review this");
      (adapter.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ content: "Re-reviewed. Looks clean now." });
      const result = await manager.send(sessionId, "I fixed the issues. Re-review?");
      expect(result.response).toBe("Re-reviewed. Looks clean now.");
      expect(result.sessionId).toBe(sessionId);
    });

    it("should include conversation history in the prompt", async () => {
      const adapter = createMockAdapter("Found bugs.");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      const { sessionId } = await manager.start("Review");
      (adapter.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ content: "Clean." });
      await manager.send(sessionId, "Fixed. Re-review?");
      const secondCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[1];
      const sentPrompt = secondCall[0] as string;
      expect(sentPrompt).toContain("Found bugs.");
      expect(sentPrompt).toContain("Fixed. Re-review?");
    });

    it("should throw if session is not active", async () => {
      const adapter = createMockAdapter("Done.");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      const { sessionId } = await manager.start("Review");
      await manager.end(sessionId);
      await expect(manager.send(sessionId, "More?")).rejects.toThrow("Session is not active");
    });

    it("should throw if session is not a collaborate session", async () => {
      const debateSession = sessionManager.create("Debate", "debate", {});
      const adapter = createMockAdapter("Response");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      await expect(manager.send(debateSession.sessionId, "Hello")).rejects.toThrow("not a collaborate session");
    });
  });

  describe("end", () => {
    it("should close the session and return message count", async () => {
      const adapter = createMockAdapter("Review done.");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      const { sessionId } = await manager.start("Review");
      const result = await manager.end(sessionId);
      expect(result.status).toBe("closed");
      expect(result.messageCount).toBe(2);
    });

    it("should set session status to closed", async () => {
      const adapter = createMockAdapter("Done.");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      const { sessionId } = await manager.start("Review");
      await manager.end(sessionId);
      const loaded = sessionManager.load(sessionId);
      expect(loaded.meta.status).toBe("closed");
    });
  });

  describe("list", () => {
    it("should only list collaborate sessions", async () => {
      const adapter = createMockAdapter("Response");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      await manager.start("Collab 1");
      sessionManager.create("Debate 1", "debate", {});
      const list = await manager.list();
      expect(list).toHaveLength(1);
      expect(list[0].agent).toBe("codex");
    });

    it("should filter to active only", async () => {
      const adapter = createMockAdapter("Response");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      const { sessionId: s1 } = await manager.start("Active");
      const { sessionId: s2 } = await manager.start("Will close");
      await manager.end(s2);
      const active = await manager.list(true);
      expect(active).toHaveLength(1);
      expect(active[0].sessionId).toBe(s1);
    });
  });

  describe("resolveSessionId", () => {
    it("should return --last as the most recent collaborate session", async () => {
      const adapter = createMockAdapter("Response");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      await manager.start("First");
      const { sessionId: latest } = await manager.start("Second");
      const resolved = manager.resolveSessionId("--last");
      expect(resolved).toBe(latest);
    });

    it("should pass through a normal session ID", () => {
      const adapter = createMockAdapter("Response");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      expect(manager.resolveSessionId("abc123")).toBe("abc123");
    });

    it("should throw if --last but no collaborate sessions exist", () => {
      const adapter = createMockAdapter("Response");
      const manager = new CollaborationManager(adapter, sessionManager, baseConfig);
      expect(() => manager.resolveSessionId("--last")).toThrow("No collaboration sessions found");
    });
  });
});
