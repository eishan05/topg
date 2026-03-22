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
 * the first message (sessions.list). Listeners are attached before the
 * connection opens to avoid race conditions.
 */
function openWs(port: number): { ws: WebSocket; firstMessage: Promise<any> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  // Register message listener immediately, before the connection opens,
  // so we don't miss the first server-sent message.
  const firstMessage = wsMessage(ws);
  return { ws, firstMessage };
}

describe("WebSocket Server", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let server: ReturnType<typeof createTopgServer>;
  let port: number;
  let testSessionId: string;

  const defaultConfig: OrchestratorConfig = {
    startWith: "claude",
    workingDirectory: "/tmp",
    guardrailRounds: 8,
    timeoutMs: 120000,
    outputFormat: "text",
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-ws-test-"));
    sessionManager = new SessionManager(tmpDir);
    const meta = sessionManager.create("WS test prompt", defaultConfig);
    testSessionId = meta.sessionId;

    server = createTopgServer({ port: 0, sessionManager });
    port = await server.start();
  });

  afterAll(async () => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends sessions.list on connection", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      const msg = await firstMessage;
      expect(msg.type).toBe("sessions.list");
      expect(Array.isArray(msg.sessions)).toBe(true);
      const found = msg.sessions.find((s: any) => s.sessionId === testSessionId);
      expect(found).toBeDefined();
      expect(found.prompt).toBe("WS test prompt");
    } finally {
      ws.close();
    }
  });

  it("returns error for unknown message type", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      // Wait for the initial sessions.list message
      await firstMessage;

      // Now register listener for the next message before sending
      const nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "nonexistent" }));
      const msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("invalid_message");
    } finally {
      ws.close();
    }
  });

  it("returns validation/not_found errors for debate control messages without required fields", async () => {
    const { ws, firstMessage } = openWs(port);
    try {
      // Wait for the initial sessions.list message
      await firstMessage;

      // debate.start without prompt -> validation_error
      let nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.start" }));
      let msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("validation_error");

      // debate.steer without sessionId -> validation_error
      nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.steer" }));
      msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("validation_error");

      // debate.pause with unknown sessionId -> not_found
      nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.pause", sessionId: "unknown" }));
      msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("not_found");

      // debate.resume without sessionId -> validation_error
      nextMsg = wsMessage(ws);
      ws.send(JSON.stringify({ type: "debate.resume" }));
      msg = await nextMsg;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("validation_error");
    } finally {
      ws.close();
    }
  });
});
