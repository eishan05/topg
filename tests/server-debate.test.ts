import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { SessionManager } from "../src/session.js";
import { createTopgServer } from "../src/server.js";
import type { OrchestratorConfig } from "../src/types.js";

/**
 * Returns a promise that resolves with the next parsed JSON message from the WebSocket.
 * Must be called BEFORE the message is expected (register the listener early to avoid races).
 */
function wsMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wsMessage timed out")), 5000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Opens a WebSocket connection and returns both the socket and a promise for
 * the first message (sessions.list).
 */
function openWs(port: number): { ws: WebSocket; firstMessage: Promise<any> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const firstMessage = wsMessage(ws);
  return { ws, firstMessage };
}

describe("WebSocket Debate Control", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let server: ReturnType<typeof createTopgServer>;
  let port: number;

  const defaultConfig: OrchestratorConfig = {
    startWith: "claude",
    workingDirectory: "/tmp",
    guardrailRounds: 5,
    timeoutMs: 120000,
    outputFormat: "text",
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-debate-test-"));
    sessionManager = new SessionManager(tmpDir);

    server = createTopgServer({ port: 0, sessionManager, defaultConfig });
    port = await server.start();
  });

  afterAll(async () => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("debate.start without prompt returns validation error", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      await firstMessage;

      const nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.start" }));
      const msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("validation_error");
      expect(msg.message).toContain("prompt");
    } finally {
      ws.close();
    }
  });

  it("debate.start with empty string prompt returns validation error", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      await firstMessage;

      const nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.start", prompt: "" }));
      const msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("validation_error");
      expect(msg.message).toContain("prompt");
    } finally {
      ws.close();
    }
  });

  it("debate.pause with unknown sessionId returns error", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      await firstMessage;

      const nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.pause", sessionId: "nonexistent-id" }));
      const msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("not_found");
      expect(msg.message).toContain("No active debate");
    } finally {
      ws.close();
    }
  });

  it("debate.resume without sessionId returns validation error", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      await firstMessage;

      const nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.resume" }));
      const msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("validation_error");
      expect(msg.message).toContain("sessionId");
    } finally {
      ws.close();
    }
  });

  it("debate.resume with nonexistent sessionId returns error", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      await firstMessage;

      const nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.resume", sessionId: "does-not-exist" }));
      const msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("not_found");
      expect(msg.message).toContain("Session not found");
    } finally {
      ws.close();
    }
  });

  it("debate.steer without sessionId returns validation error", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      await firstMessage;

      const nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.steer", guidance: "some guidance" }));
      const msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("validation_error");
      expect(msg.message).toContain("sessionId");
    } finally {
      ws.close();
    }
  });

  it("debate.steer without guidance returns validation error", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      await firstMessage;

      const nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.steer", sessionId: "some-id" }));
      const msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("validation_error");
      expect(msg.message).toContain("guidance");
    } finally {
      ws.close();
    }
  });
});
