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
});
