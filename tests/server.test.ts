import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { SessionManager } from "../src/session.js";
import { createTopgServer } from "../src/server.js";
import type { OrchestratorConfig } from "../src/types.js";

function httpGet(port: number, urlPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

describe("HTTP Server", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-server-test-"));
    sessionManager = new SessionManager(tmpDir);
    const meta = sessionManager.create("Test server prompt", defaultConfig);
    testSessionId = meta.sessionId;

    server = createTopgServer({ port: 0, sessionManager });
    port = await server.start();
  });

  afterAll(async () => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET / returns 200 with text/html", async () => {
    const res = await httpGet(port, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("<title>topg</title>");
  });

  it("GET /api/sessions returns 200 with JSON array containing test session", async () => {
    const res = await httpGet(port, "/api/sessions");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const sessions = JSON.parse(res.body);
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const found = sessions.find((s: any) => s.sessionId === testSessionId);
    expect(found).toBeDefined();
    expect(found.prompt).toBe("Test server prompt");
  });

  it("GET /api/sessions/:id returns 200 with { meta, messages }", async () => {
    const res = await httpGet(port, `/api/sessions/${testSessionId}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const data = JSON.parse(res.body);
    expect(data.meta).toBeDefined();
    expect(data.messages).toBeDefined();
    expect(data.meta.sessionId).toBe(testSessionId);
    expect(Array.isArray(data.messages)).toBe(true);
  });

  it("GET /api/sessions/nonexistent returns 404", async () => {
    const res = await httpGet(port, "/api/sessions/nonexistent");
    expect(res.status).toBe(404);
  });

  it("GET /styles.css returns correct text/css content-type if file exists", async () => {
    // Create a styles.css in the public dir so the test can verify MIME handling
    const projectRoot = path.resolve(__dirname, "..");
    const publicDir = path.join(projectRoot, "src", "web", "public");
    const cssPath = path.join(publicDir, "styles.css");
    const cssExisted = fs.existsSync(cssPath);

    if (!cssExisted) {
      fs.mkdirSync(publicDir, { recursive: true });
      fs.writeFileSync(cssPath, "body { margin: 0; }");
    }

    try {
      const res = await httpGet(port, "/styles.css");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/css");
    } finally {
      if (!cssExisted) {
        fs.unlinkSync(cssPath);
      }
    }
  });
});
