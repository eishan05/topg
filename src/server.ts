import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "./session.js";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { Orchestrator } from "./orchestrator.js";
import { DEFAULT_CODEX_CONFIG } from "./types.js";
import type { CodexConfig, OrchestratorConfig, OrchestratorResult } from "./types.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

interface ActiveDebate {
  orchestrator: Orchestrator;
  abortController: AbortController;
  lastResult?: OrchestratorResult;
  config: OrchestratorConfig;
}

export interface TopgServerOptions {
  port: number;
  sessionManager: SessionManager;
  defaultConfig?: OrchestratorConfig;
}

export function createTopgServer(opts: TopgServerOptions) {
  const { sessionManager } = opts;

  const defaultConfig: OrchestratorConfig = opts.defaultConfig ?? {
    startWith: "claude",
    workingDirectory: process.cwd(),
    guardrailRounds: 5,
    timeoutMs: 900000,
    outputFormat: "text",
    codex: { ...DEFAULT_CODEX_CONFIG },
  };

  const activeDebates = new Map<string, ActiveDebate>();

  // Resolve static files relative to project root, NOT the current module dir.
  // After tsc build, this file is at dist/server.js, but static assets stay in src/web/public/.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, "..");
  const publicDir = path.join(projectRoot, "src", "web", "public");

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // API routes
    if (pathname === "/api/sessions" && req.method === "GET") {
      const sessions = sessionManager.listSessions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const sessionId = sessionMatch[1];
      try {
        const data = sessionManager.load(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
      return;
    }

    // Static file serving
    let filePath: string;
    if (pathname === "/") {
      filePath = path.join(publicDir, "index.html");
    } else {
      // Directory traversal protection: resolve and verify it stays within publicDir
      const resolved = path.resolve(publicDir, pathname.slice(1));
      if (!resolved.startsWith(publicDir)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      filePath = resolved;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set<WebSocket>();

  function broadcast(data: unknown) {
    const payload = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  function broadcastSessionsList() {
    const sessions = sessionManager.listSessions();
    broadcast({ type: "sessions.list", sessions });
  }

  function createAdapters(config: OrchestratorConfig) {
    const yolo = !!config.yolo;
    const claude = new ClaudeAdapter(config.timeoutMs, yolo);
    const codex = new CodexAdapter(config.timeoutMs, config.codex, yolo);
    return { claude, codex };
  }

  function createOrchestrator(config: OrchestratorConfig, sessionId?: string) {
    const { claude, codex } = createAdapters(config);
    const orchestrator = new Orchestrator(
      claude,
      codex,
      sessionManager,
      config,
      {
        onTurnStart: (turn, agent, role) => {
          broadcast({
            type: "turn.start",
            sessionId,
            turn,
            agent,
            role,
          });
        },
        onTurnComplete: (message) => {
          broadcast({
            type: "turn.complete",
            sessionId,
            message,
          });
        },
      },
    );
    return orchestrator;
  }

  function handleDebateCompletion(sessionId: string, result: OrchestratorResult) {
    const debate = activeDebates.get(sessionId);
    if (debate) {
      debate.lastResult = result;
    }
    broadcast({ type: "debate.result", sessionId, result });
    broadcastSessionsList();
    activeDebates.delete(sessionId);
  }

  function handleDebateError(sessionId: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    broadcast({ type: "error", code: "debate_error", message });
    try {
      sessionManager.updateStatus(sessionId, "paused");
    } catch {
      // Session may not exist yet if error happened during creation
    }
    broadcastSessionsList();
    activeDebates.delete(sessionId);
  }

  function handleDebateStart(ws: WebSocket, msg: { type: string; [key: string]: unknown }) {
    // Validate prompt
    const prompt = msg.prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      ws.send(JSON.stringify({
        type: "error",
        code: "validation_error",
        message: "Missing or empty prompt",
      }));
      return;
    }

    // Merge config — strip dangerous fields that clients must not control.
    // The server never honors `yolo` from WebSocket clients, and blocks
    // `sandboxMode: "danger-full-access"` and `approvalPolicy` overrides.
    const rawConfig = (msg.config && typeof msg.config === "object")
      ? (msg.config as Record<string, unknown>)
      : {};
    const { yolo: _yolo, ...safeConfigFields } = rawConfig;
    const msgConfig = safeConfigFields as Partial<OrchestratorConfig>;

    if (msgConfig.codex && typeof msgConfig.codex === "object") {
      const { sandboxMode, approvalPolicy, ...safeCodexFields } = msgConfig.codex as CodexConfig;
      // Only allow sandboxMode if it's not the dangerous full-access mode
      const safeSandbox = sandboxMode === "danger-full-access" ? undefined : sandboxMode;
      msgConfig.codex = {
        ...defaultConfig.codex,
        ...safeCodexFields,
        ...(safeSandbox ? { sandboxMode: safeSandbox } : {}),
      };
    }
    const config: OrchestratorConfig = { ...defaultConfig, ...msgConfig };

    // Create session
    const meta = sessionManager.create(prompt, config);
    const sessionId = meta.sessionId;

    // We pre-create the session so we have a sessionId to track the debate,
    // then use runWithHistory (which does not create its own session) to avoid duplicates.
    const abortController = new AbortController();
    const orchestrator = createOrchestrator(config, sessionId);

    activeDebates.set(sessionId, {
      orchestrator,
      abortController,
      config,
    });

    // Confirm to the requesting client with the new sessionId
    ws.send(JSON.stringify({ type: "debate.started", sessionId }));

    // Broadcast updated session list so all clients see the new active session
    broadcastSessionsList();

    // Run debate asynchronously using runWithHistory (session already created)
    orchestrator.runWithHistory(prompt, [], sessionId, abortController.signal)
      .then((result) => handleDebateCompletion(sessionId, result))
      .catch((err) => handleDebateError(sessionId, err));
  }

  function handleDebatePause(ws: WebSocket, msg: { type: string; [key: string]: unknown }) {
    const sessionId = msg.sessionId as string;
    const debate = activeDebates.get(sessionId);

    if (!debate) {
      ws.send(JSON.stringify({
        type: "error",
        code: "not_found",
        message: `No active debate found for sessionId: ${sessionId}`,
      }));
      return;
    }

    debate.abortController.abort();
    sessionManager.updateStatus(sessionId, "paused");
    activeDebates.delete(sessionId);
    broadcastSessionsList();
  }

  function handleDebateResume(ws: WebSocket, msg: { type: string; [key: string]: unknown }) {
    // Validate sessionId
    const sessionId = msg.sessionId;
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      ws.send(JSON.stringify({
        type: "error",
        code: "validation_error",
        message: "Missing or empty sessionId",
      }));
      return;
    }

    // Check session exists
    let sessionData;
    try {
      sessionData = sessionManager.load(sessionId);
    } catch {
      ws.send(JSON.stringify({
        type: "error",
        code: "not_found",
        message: `Session not found: ${sessionId}`,
      }));
      return;
    }

    const config: OrchestratorConfig = sessionData.meta.config ?? defaultConfig;
    const abortController = new AbortController();
    const orchestrator = createOrchestrator(config, sessionId);

    activeDebates.set(sessionId, {
      orchestrator,
      abortController,
      config,
    });

    // Resume the debate asynchronously
    orchestrator.resume(sessionId)
      .then((result) => handleDebateCompletion(sessionId, result))
      .catch((err) => handleDebateError(sessionId, err));
  }

  function handleDebateSteer(ws: WebSocket, msg: { type: string; [key: string]: unknown }) {
    // Validate sessionId
    const sessionId = msg.sessionId;
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      ws.send(JSON.stringify({
        type: "error",
        code: "validation_error",
        message: "Missing or empty sessionId",
      }));
      return;
    }

    // Validate guidance
    const guidance = msg.guidance;
    if (typeof guidance !== "string" || guidance.trim().length === 0) {
      ws.send(JSON.stringify({
        type: "error",
        code: "validation_error",
        message: "Missing or empty guidance",
      }));
      return;
    }

    // Look up lastResult from active debates, or reconstruct from session data
    let previousResult: OrchestratorResult;
    const activeDebate = activeDebates.get(sessionId);

    if (activeDebate?.lastResult) {
      previousResult = activeDebate.lastResult;
    } else {
      // Try to reconstruct from session data
      let sessionData;
      try {
        sessionData = sessionManager.load(sessionId);
      } catch {
        ws.send(JSON.stringify({
          type: "error",
          code: "not_found",
          message: `Session not found: ${sessionId}`,
        }));
        return;
      }

      const lastTurn = sessionData.messages.length > 0
        ? sessionData.messages[sessionData.messages.length - 1].turn
        : 0;

      previousResult = {
        type: sessionData.meta.status === "escalated" ? "escalation" : "consensus",
        sessionId,
        rounds: lastTurn,
        summary: "",
        messages: sessionData.messages,
      };
    }

    const config: OrchestratorConfig = activeDebate?.config ?? defaultConfig;
    const abortController = new AbortController();
    const orchestrator = createOrchestrator(config, sessionId);

    activeDebates.set(sessionId, {
      orchestrator,
      abortController,
      config,
    });

    // Run with guidance asynchronously
    orchestrator.continueWithGuidance(previousResult, guidance, sessionId, abortController.signal)
      .then((result) => handleDebateCompletion(sessionId, result))
      .catch((err) => handleDebateError(sessionId, err));
  }

  function handleWsMessage(ws: WebSocket, msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case "debate.start":
        handleDebateStart(ws, msg);
        break;
      case "debate.pause":
        handleDebatePause(ws, msg);
        break;
      case "debate.resume":
        handleDebateResume(ws, msg);
        break;
      case "debate.steer":
        handleDebateSteer(ws, msg);
        break;
      default:
        ws.send(JSON.stringify({ type: "error", code: "invalid_message", message: `Unknown type: ${msg.type}` }));
        break;
    }
  }

  wss.on("connection", (ws) => {
    clients.add(ws);

    // Send current sessions list on connect
    const sessions = sessionManager.listSessions();
    ws.send(JSON.stringify({ type: "sessions.list", sessions }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleWsMessage(ws, msg);
      } catch {
        ws.send(JSON.stringify({ type: "error", code: "invalid_message", message: "Failed to parse JSON" }));
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  return {
    httpServer,
    wss,
    broadcast,
    start(): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(opts.port, "127.0.0.1", () => {
          const addr = httpServer.address();
          if (addr && typeof addr === "object") {
            resolve(addr.port);
          } else {
            reject(new Error("Failed to get server address"));
          }
        });
      });
    },
    close() {
      // Abort all active debates on server close
      for (const [, debate] of activeDebates) {
        debate.abortController.abort();
      }
      activeDebates.clear();
      wss.close();
      httpServer.close();
    },
  };
}
