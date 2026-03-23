import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "../src/session.js";
import type { Message, OrchestratorConfig } from "../src/types.js";

describe("SessionManager", () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-test-"));
    manager = new SessionManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const defaultConfig: OrchestratorConfig = {
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
  };

  it("should create a new session with meta.json", () => {
    const session = manager.create("Design an auth system", defaultConfig);
    expect(session.sessionId).toBeTruthy();
    const metaPath = path.join(tmpDir, session.sessionId, "meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.version).toBe(1);
    expect(meta.status).toBe("active");
    expect(meta.prompt).toBe("Design an auth system");
  });

  it("should append messages to transcript.jsonl", () => {
    const session = manager.create("Test prompt", defaultConfig);
    const msg: Message = {
      role: "initiator",
      agent: "claude",
      turn: 1,
      type: "code",
      content: "Here is my response",
      timestamp: new Date().toISOString(),
    };
    manager.appendMessage(session.sessionId, msg);
    const transcriptPath = path.join(tmpDir, session.sessionId, "transcript.jsonl");
    const lines = fs.readFileSync(transcriptPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).agent).toBe("claude");
  });

  it("should load an existing session", () => {
    const session = manager.create("Test prompt", defaultConfig);
    const msg: Message = {
      role: "initiator",
      agent: "claude",
      turn: 1,
      type: "code",
      content: "Response content",
      timestamp: new Date().toISOString(),
    };
    manager.appendMessage(session.sessionId, msg);
    const loaded = manager.load(session.sessionId);
    expect(loaded.meta.prompt).toBe("Test prompt");
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].content).toBe("Response content");
  });

  it("should update session status", () => {
    const session = manager.create("Test prompt", defaultConfig);
    manager.updateStatus(session.sessionId, "paused");
    const loaded = manager.load(session.sessionId);
    expect(loaded.meta.status).toBe("paused");
  });

  it("should save summary", () => {
    const session = manager.create("Test prompt", defaultConfig);
    manager.saveSummary(session.sessionId, "# Consensus\nThey agreed.");
    const summaryPath = path.join(tmpDir, session.sessionId, "summary.md");
    expect(fs.readFileSync(summaryPath, "utf-8")).toContain("They agreed.");
  });

  it("should throw when loading a nonexistent session", () => {
    expect(() => manager.load("nonexistent")).toThrow();
  });

  it("should list all sessions", () => {
    manager.create("First prompt", defaultConfig);
    manager.create("Second prompt", defaultConfig);

    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(2);
    const prompts = sessions.map((s) => s.prompt);
    expect(prompts).toContain("First prompt");
    expect(prompts).toContain("Second prompt");
  });

  it("should return empty array when no sessions exist", () => {
    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(0);
  });

  it("should update the prompt in session metadata", () => {
    const session = manager.create("(interactive session)", defaultConfig);
    manager.updatePrompt(session.sessionId, "Should we use React?");
    const loaded = manager.load(session.sessionId);
    expect(loaded.meta.prompt).toBe("Should we use React?");
  });

  it("should reject path traversal in session IDs", () => {
    expect(() => manager.deleteSession("../../etc")).toThrow("Invalid session ID");
    expect(() => manager.load("../../../foo")).toThrow("Invalid session ID");
  });

  it("should delete an existing session", () => {
    const session = manager.create("Delete me", defaultConfig);
    const dir = path.join(tmpDir, session.sessionId);
    expect(fs.existsSync(dir)).toBe(true);
    manager.deleteSession(session.sessionId);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("should throw when deleting a nonexistent session", () => {
    expect(() => manager.deleteSession("nonexistent")).toThrow("Session not found: nonexistent");
  });

  it("should filter sessions by status", () => {
    const s1 = manager.create("First", defaultConfig);
    const s2 = manager.create("Second", defaultConfig);
    manager.updateStatus(s1.sessionId, "completed");
    manager.updateStatus(s2.sessionId, "escalated");

    const completed = manager.filterSessions({ statuses: ["completed"] });
    expect(completed).toHaveLength(1);
    expect(completed[0].sessionId).toBe(s1.sessionId);

    const both = manager.filterSessions({ statuses: ["completed", "escalated"] });
    expect(both).toHaveLength(2);
  });

  it("should filter sessions by age", () => {
    const s1 = manager.create("Old session", defaultConfig);
    manager.create("New session", defaultConfig);

    // Manually backdate s1's updatedAt
    const metaPath = path.join(tmpDir, s1.sessionId, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    meta.updatedAt = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const cutoff = new Date(Date.now() - 7 * 86400000); // 7 days ago
    const old = manager.filterSessions({ olderThan: cutoff });
    expect(old).toHaveLength(1);
    expect(old[0].prompt).toBe("Old session");
  });

  it("should filter sessions by status and age combined", () => {
    const s1 = manager.create("Old completed", defaultConfig);
    const s2 = manager.create("New completed", defaultConfig);
    const s3 = manager.create("Old active", defaultConfig);
    manager.updateStatus(s1.sessionId, "completed");
    manager.updateStatus(s2.sessionId, "completed");

    // Backdate s1 and s3
    for (const s of [s1, s3]) {
      const metaPath = path.join(tmpDir, s.sessionId, "meta.json");
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      meta.updatedAt = new Date(Date.now() - 10 * 86400000).toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }

    const cutoff = new Date(Date.now() - 7 * 86400000);
    const result = manager.filterSessions({ statuses: ["completed"], olderThan: cutoff });
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toBe("Old completed");
  });
});
