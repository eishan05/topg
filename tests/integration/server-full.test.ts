import { describe, it, expect, afterAll } from "vitest";
import { WebSocket } from "ws";
import { createTopgServer } from "../../src/server.js";
import { SessionManager } from "../../src/session.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("server full integration", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-int-"));
  const session = new SessionManager(tmpDir);
  let server: ReturnType<typeof createTopgServer>;
  let port: number;

  afterAll(() => {
    server?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves index.html and establishes WS connection", async () => {
    server = createTopgServer({ port: 0, sessionManager: session });
    port = await server.start();

    // HTTP serves index.html
    const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("topg");
    expect(html).toContain('class="layout"');

    // CSS is served with correct content-type
    const cssRes = await fetch(`http://127.0.0.1:${port}/styles.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");

    // JS is served with correct content-type
    const jsRes = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("text/javascript");

    // WebSocket connects and receives sessions.list
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    // Register listener before connection opens to avoid race
    const msgPromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS message timed out")), 5000);
      ws.once("message", (d) => {
        clearTimeout(timer);
        resolve(JSON.parse(d.toString()));
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    const msg = await msgPromise;
    expect(msg.type).toBe("sessions.list");
    expect(Array.isArray(msg.sessions)).toBe(true);
    ws.close();
  });

  it("serves session data via REST API", async () => {
    // Create a test session
    const meta = session.create("integration test prompt", {
      startWith: "claude",
      workingDirectory: "/tmp",
      guardrailRounds: 5,
      timeoutMs: 10000,
      outputFormat: "text",
    });

    // GET /api/sessions returns the session
    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(listRes.status).toBe(200);
    const sessions = await listRes.json();
    expect(sessions.some((s: any) => s.sessionId === meta.sessionId)).toBe(true);

    // GET /api/sessions/:id returns session detail
    const detailRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${meta.sessionId}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.meta.sessionId).toBe(meta.sessionId);
    expect(detail.meta.prompt).toBe("integration test prompt");
    expect(Array.isArray(detail.messages)).toBe(true);
  });
});
