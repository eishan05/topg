# Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `topg serve` — a local web dashboard for viewing, starting, and steering agent debates.

**Architecture:** `node:http` server + `ws` WebSocket server reusing existing `SessionManager` and `Orchestrator`. Vanilla HTML/CSS/JS frontend with sidebar + main content layout. No build step, no framework.

**Tech Stack:** TypeScript (server), vanilla JS (client), `ws` package, `node:http`

**Spec:** `docs/superpowers/specs/2026-03-22-web-dashboard-design.md`

---

### Task 1: Install Dependencies and Refactor Orchestrator Callbacks

**Files:**
- Modify: `package.json` (add `ws`, `@types/ws`)
- Modify: `src/orchestrator.ts` (refactor callbacks to options object, add `onTurnComplete`)
- Modify: `src/repl.ts:131` (update Orchestrator constructor call)
- Modify: `src/index.ts:72` (update Orchestrator constructor call)
- Modify: `tests/integration/full-loop.test.ts` (update constructor calls if needed)
- Test: `tests/orchestrator-callbacks.test.ts`

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/eishanlawrence/dev/topgstack
npm install ws
npm install -D @types/ws
```

- [ ] **Step 2: Write failing test for onTurnComplete callback**

Create `tests/orchestrator-callbacks.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import type { AgentAdapter } from "../src/adapters/agent-adapter.js";
import { SessionManager } from "../src/session.js";
import type { OrchestratorConfig, Message } from "../src/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function mockAdapter(name: "claude" | "codex"): AgentAdapter {
  return {
    name,
    send: vi.fn().mockResolvedValue({
      content: "Test response [CONVERGENCE: agree]",
      artifacts: [],
      convergenceSignal: "agree" as const,
    }),
  };
}

describe("Orchestrator callbacks", () => {
  it("calls onTurnComplete after each message is appended", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-test-"));
    const session = new SessionManager(tmpDir);
    const claude = mockAdapter("claude");
    const codex = mockAdapter("codex");
    const config: OrchestratorConfig = {
      startWith: "claude",
      workingDirectory: "/tmp",
      guardrailRounds: 5,
      timeoutMs: 10000,
      outputFormat: "text",
    };

    const completedMessages: Message[] = [];
    const orch = new Orchestrator(claude, codex, session, config, {
      onTurnComplete: (msg) => completedMessages.push(msg),
    });

    await orch.run("test prompt");

    expect(completedMessages.length).toBeGreaterThanOrEqual(2);
    expect(completedMessages[0].agent).toBe("claude");
    expect(completedMessages[0].role).toBe("initiator");
    expect(completedMessages[1].agent).toBe("codex");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("supports legacy positional TurnCallback for backwards compat", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-test-"));
    const session = new SessionManager(tmpDir);
    const claude = mockAdapter("claude");
    const codex = mockAdapter("codex");
    const config: OrchestratorConfig = {
      startWith: "claude",
      workingDirectory: "/tmp",
      guardrailRounds: 5,
      timeoutMs: 10000,
      outputFormat: "text",
    };

    const turns: number[] = [];
    const orch = new Orchestrator(claude, codex, session, config, {
      onTurnStart: (turn) => turns.push(turn),
    });

    await orch.run("test prompt");
    expect(turns.length).toBeGreaterThanOrEqual(2);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/orchestrator-callbacks.test.ts
```

Expected: FAIL — Orchestrator constructor doesn't accept an options object yet.

- [ ] **Step 4: Refactor Orchestrator constructor**

In `src/orchestrator.ts`, change the constructor signature and add `onTurnComplete`:

Replace the existing type and constructor (lines 8-29):

```typescript
export type TurnCallback = (turn: number, agent: AgentName, role: string) => void;
export type TurnCompleteCallback = (message: Message) => void;

export interface OrchestratorCallbacks {
  onTurnStart?: TurnCallback;
  onTurnComplete?: TurnCompleteCallback;
}

export class Orchestrator {
  private agentA: AgentAdapter;
  private agentB: AgentAdapter;
  private session: SessionManager;
  private config: OrchestratorConfig;
  private onTurnStart?: TurnCallback;
  private onTurnComplete?: TurnCompleteCallback;

  constructor(
    agentA: AgentAdapter,
    agentB: AgentAdapter,
    session: SessionManager,
    config: OrchestratorConfig,
    callbacks?: OrchestratorCallbacks
  ) {
    this.agentA = config.startWith === agentA.name ? agentA : agentB;
    this.agentB = config.startWith === agentA.name ? agentB : agentA;
    this.config = config;
    this.session = session;
    this.onTurnStart = callbacks?.onTurnStart;
    this.onTurnComplete = callbacks?.onTurnComplete;
  }
```

Then add `this.onTurnComplete?.(msg)` after every `this.session.appendMessage(...)` call in all four methods: `run()`, `runWithHistory()`, `resume()`, `continueWithGuidance()`. There are ~16 `appendMessage` calls total — add the callback line after each one. Use grep to find them all: `grep -n "appendMessage" src/orchestrator.ts`.

- [ ] **Step 5: Update callers in repl.ts and index.ts**

In `src/repl.ts:131`, change:
```typescript
// Before:
let orchestrator = new Orchestrator(claude, codex, session, config, onTurnStart);
// After:
let orchestrator = new Orchestrator(claude, codex, session, config, { onTurnStart });
```

Also update the other `new Orchestrator(...)` call at `repl.ts:140` and `repl.ts:268`.

In `src/index.ts:72`, change:
```typescript
// Before:
const orchestrator = new Orchestrator(claude, codex, session, config, (turn, agent, role) => {
  const label = agent.charAt(0).toUpperCase() + agent.slice(1);
  console.error(`[Turn ${turn}] ${label} (${role}): responding...`);
});
// After:
const orchestrator = new Orchestrator(claude, codex, session, config, {
  onTurnStart: (turn, agent, role) => {
    const label = agent.charAt(0).toUpperCase() + agent.slice(1);
    console.error(`[Turn ${turn}] ${label} (${role}): responding...`);
  },
});
```

- [ ] **Step 6: Update integration tests if needed**

Check `tests/integration/full-loop.test.ts` for Orchestrator constructor calls and update them to use the new `{ onTurnStart }` object form.

- [ ] **Step 7: Run all tests**

```bash
npx vitest run
```

Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/orchestrator.ts src/repl.ts src/index.ts tests/
git commit -m "refactor: Orchestrator callbacks to options object, add onTurnComplete"
```

---

### Task 2: HTTP Server with Static File Serving and REST API

**Files:**
- Create: `src/server.ts`
- Create: `src/web/public/index.html` (minimal placeholder)
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write failing test for HTTP server**

Create `tests/server.test.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { createTopgServer } from "../src/server.js";
import { SessionManager } from "../src/session.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("topg HTTP server", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-srv-"));
  const session = new SessionManager(tmpDir);

  // Create a test session
  const meta = session.create("test prompt", {
    startWith: "claude",
    workingDirectory: "/tmp",
    guardrailRounds: 5,
    timeoutMs: 10000,
    outputFormat: "text",
  });

  let server: ReturnType<typeof createTopgServer>;
  let port: number;

  afterAll(async () => {
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("starts and serves static files", async () => {
    server = createTopgServer({ port: 0, sessionManager: session });
    port = await server.start();

    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("GET /api/sessions returns session list", async () => {
    const res = await fetch(`http://localhost:${port}/api/sessions`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].sessionId).toBe(meta.sessionId);
  });

  it("GET /api/sessions/:id returns session detail", async () => {
    const res = await fetch(`http://localhost:${port}/api/sessions/${meta.sessionId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.meta.sessionId).toBe(meta.sessionId);
    expect(Array.isArray(data.messages)).toBe(true);
  });

  it("GET /api/sessions/:id returns 404 for unknown session", async () => {
    const res = await fetch(`http://localhost:${port}/api/sessions/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("serves CSS with correct content-type", async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    // May be 404 if file doesn't exist yet, but if it does, check content-type
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toContain("text/css");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/server.test.ts
```

Expected: FAIL — `createTopgServer` doesn't exist yet.

- [ ] **Step 3: Create minimal index.html placeholder**

Create `src/web/public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>topg</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app">Loading...</div>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Implement server.ts**

Create `src/server.ts`:

```typescript
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "./session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

interface ServerOptions {
  port: number;
  sessionManager: SessionManager;
}

export function createTopgServer(opts: ServerOptions) {
  const { sessionManager } = opts;
  // After tsc build, __dirname is dist/. Static assets stay in src/.
  // Resolve up to project root and always serve from src/web/public/.
  const projectRoot = path.resolve(__dirname, "..");
  const publicDir = path.join(projectRoot, "src", "web", "public");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // REST API
    if (pathname === "/api/sessions") {
      const sessions = sessionManager.listSessions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      try {
        const data = sessionManager.load(sessionMatch[1]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
      }
      return;
    }

    // Static files
    let filePath = pathname === "/" ? "/index.html" : pathname;
    filePath = path.join(publicDir, filePath);

    // Prevent directory traversal
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return {
    start(overridePort?: number): Promise<number> {
      const p = overridePort ?? opts.port;
      return new Promise((resolve, reject) => {
        server.listen(p, "127.0.0.1", () => {
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : p;
          resolve(actualPort);
        });
        server.on("error", reject);
      });
    },
    close() {
      server.close();
    },
    httpServer: server,
  };
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/server.test.ts
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/web/public/index.html tests/server.test.ts
git commit -m "feat: HTTP server with static files and session REST API"
```

---

### Task 3: WebSocket Server and Event Broadcasting

**Files:**
- Modify: `src/server.ts` (add WS upgrade, message handling, broadcast)
- Test: `tests/server-ws.test.ts`

- [ ] **Step 1: Write failing test for WebSocket connection and sessions.list**

Create `tests/server-ws.test.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { WebSocket } from "ws";
import { createTopgServer } from "../src/server.js";
import { SessionManager } from "../src/session.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function wsMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

describe("topg WebSocket server", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-ws-"));
  const session = new SessionManager(tmpDir);
  session.create("test prompt", {
    startWith: "claude",
    workingDirectory: "/tmp",
    guardrailRounds: 5,
    timeoutMs: 10000,
    outputFormat: "text",
  });

  let server: ReturnType<typeof createTopgServer>;
  let port: number;

  afterAll(async () => {
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("sends sessions.list on connection", async () => {
    server = createTopgServer({ port: 0, sessionManager: session });
    port = await server.start();

    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise((r) => ws.on("open", r));

    const msg = await wsMessage(ws);
    expect(msg.type).toBe("sessions.list");
    expect(Array.isArray(msg.sessions)).toBe(true);
    expect(msg.sessions.length).toBe(1);

    ws.close();
  });

  it("responds to invalid messages with error", async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise((r) => ws.on("open", r));
    await wsMessage(ws); // consume sessions.list

    ws.send(JSON.stringify({ type: "nonexistent" }));
    const msg = await wsMessage(ws);
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("invalid_message");

    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/server-ws.test.ts
```

Expected: FAIL — no WebSocket support in server yet.

- [ ] **Step 3: Add WebSocket support to server.ts**

Add to `src/server.ts`:

```typescript
import { WebSocketServer, WebSocket } from "ws";
```

After creating the HTTP server, add WebSocket upgrade handling:

```typescript
const wss = new WebSocketServer({ server });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);

  // Send session list on connect
  const sessions = sessionManager.listSessions();
  ws.send(JSON.stringify({ type: "sessions.list", sessions }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleWsMessage(ws, msg);
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "parse_error", message: "Invalid JSON" }));
    }
  });

  ws.on("close", () => clients.delete(ws));
});

function broadcast(data: unknown) {
  const json = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

function handleWsMessage(ws: WebSocket, msg: any) {
  switch (msg.type) {
    case "debate.start":
    case "debate.steer":
    case "debate.pause":
    case "debate.resume":
      // Implemented in Task 4
      ws.send(JSON.stringify({ type: "error", code: "not_implemented", message: "Coming soon" }));
      break;
    default:
      ws.send(JSON.stringify({ type: "error", code: "invalid_message", message: `Unknown type: ${msg.type}` }));
  }
}
```

Expose `broadcast` in the return object for use by debate handlers.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/server-ws.test.ts
```

Expected: ALL PASS

- [ ] **Step 5: Run all tests to confirm no regressions**

```bash
npx vitest run
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server-ws.test.ts
git commit -m "feat: WebSocket server with connection handling and broadcast"
```

---

### Task 4: Debate Control via WebSocket (start, pause, resume, steer)

**Files:**
- Modify: `src/server.ts` (implement WS message handlers for debate operations)
- Test: `tests/server-debate.test.ts`

- [ ] **Step 1: Write failing test for debate.start**

Create `tests/server-debate.test.ts`:

```typescript
import { describe, it, expect, afterAll, vi } from "vitest";
import { WebSocket } from "ws";
import { createTopgServer } from "../src/server.js";
import { SessionManager } from "../src/session.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function wsMessages(ws: WebSocket, count: number, timeoutMs = 30000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    ws.on("message", (data) => {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= count) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
  });
}

describe("topg debate control", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topg-debate-"));
  const session = new SessionManager(tmpDir);

  let server: ReturnType<typeof createTopgServer>;
  let port: number;

  afterAll(() => {
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles debate.pause for unknown session with error", async () => {
    server = createTopgServer({ port: 0, sessionManager: session });
    port = await server.start();

    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise((r) => ws.on("open", r));

    // Consume sessions.list
    await new Promise<void>((r) => ws.once("message", () => r()));

    ws.send(JSON.stringify({ type: "debate.pause", sessionId: "nonexistent" }));

    const msg = await new Promise<any>((r) =>
      ws.once("message", (d) => r(JSON.parse(d.toString())))
    );
    expect(msg.type).toBe("error");
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/server-debate.test.ts
```

Expected: FAIL — debate handlers return "not_implemented".

- [ ] **Step 3: Implement debate handlers in server.ts**

The server needs to:
1. Track active debates (Map of sessionId → { orchestrator, abortController })
2. Create adapters + orchestrator for `debate.start`
3. Wire `onTurnStart` and `onTurnComplete` to broadcast
4. Handle `debate.pause` (abort controller), `debate.resume` (orchestrator.resume), `debate.steer` (orchestrator.continueWithGuidance)

Add to `src/server.ts`:

```typescript
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { Orchestrator } from "./orchestrator.js";
import type { OrchestratorConfig, OrchestratorResult } from "./types.js";

interface ActiveDebate {
  orchestrator: Orchestrator;
  abortController: AbortController;
  lastResult?: OrchestratorResult;
  config: OrchestratorConfig;
}

const activeDebates = new Map<string, ActiveDebate>();
```

Then implement `handleWsMessage` cases:

- `debate.start`: Create adapters, orchestrator with broadcast callbacks, run `runWithHistory` in background (non-blocking), send `turn.start`/`turn.complete`/`debate.result` events.
- `debate.pause`: Call `abortController.abort()`, update session status.
- `debate.resume`: Load session, create new orchestrator, call `resume()`.
- `debate.steer`: Use cached `lastResult`, call `continueWithGuidance()`.

After each debate completes or errors, broadcast `sessions.list` to all clients so the sidebar updates.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/server-debate.test.ts
```

Expected: ALL PASS

- [ ] **Step 5: Run all tests**

```bash
npx vitest run
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server-debate.test.ts
git commit -m "feat: WebSocket debate control (start, pause, resume, steer)"
```

---

### Task 5: CLI `serve` Subcommand

**Files:**
- Modify: `src/index.ts` (add `serve` subcommand)

- [ ] **Step 1: Add serve subcommand to index.ts**

Add before the existing `.argument("[prompt]")` chain:

```typescript
import { createTopgServer } from "./server.js";

program
  .command("serve")
  .description("Start the web dashboard")
  .option("--port <number>", "Port to listen on", "4747")
  .action(async (opts) => {
    if (!process.env.OPENAI_API_KEY) {
      console.error("Error: OPENAI_API_KEY is required for Codex.");
      process.exit(1);
    }

    const port = parseInt(opts.port, 10);
    const session = new SessionManager();
    const server = createTopgServer({ port, sessionManager: session });

    const actualPort = await server.start();
    console.error(`topg dashboard running at http://localhost:${actualPort}`);
    console.error("Press Ctrl+C to stop.\n");

    process.on("SIGINT", () => {
      console.error("\nShutting down...");
      server.close();
      process.exit(0);
    });
  });
```

- [ ] **Step 2: Build and verify the command registers**

```bash
npm run build && node dist/index.js serve --help
```

Expected: Shows serve command help with `--port` option.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add 'topg serve' CLI subcommand"
```

---

### Task 6: Frontend — HTML Shell and CSS Theme

**Files:**
- Modify: `src/web/public/index.html` (full sidebar + main layout)
- Create: `src/web/public/styles.css`

- [ ] **Step 1: Write index.html with sidebar + main layout**

Replace the placeholder `src/web/public/index.html` with the full SPA shell:
- Sidebar: logo, new debate button, session list container, session group labels
- Main area: empty state (shown by default), debate viewer (hidden), new debate form (hidden)
- Debate viewer: header bar, convergence bar, message thread container, outcome bar, guidance input
- New debate form: prompt textarea, advanced config section, start button
- All elements have `id` attributes for JS targeting

Use semantic HTML. No inline styles — everything in `styles.css`.

- [ ] **Step 2: Write styles.css**

Create `src/web/public/styles.css` with the terminal dark theme from the spec:
- CSS custom properties for all colors (background, surface, border, text, muted, claude-accent, codex-accent, link, warning, error)
- Grid layout: `grid-template-columns: 280px 1fr`
- Sidebar styles: header, session list, session items with status dots, active state
- Main area styles: debate header, convergence bar, message thread, message avatars, signal badges
- Code block styling with syntax color classes
- Outcome bar (consensus green, escalation amber)
- Guidance input bar
- Live typing indicator animation
- Pulsing animation for active status dot
- Scrollbar styling
- All responsive within the grid (no mobile — this is a local dev tool)

Reference the mockup at `.superpowers/brainstorm/69181-1774220051/dashboard-v2.html` for exact styles.

- [ ] **Step 3: Build and test manually**

```bash
npm run build && node dist/index.js serve --port 4747
```

Open `http://localhost:4747` — verify the layout renders correctly with the empty state.

- [ ] **Step 4: Commit**

```bash
git add src/web/public/index.html src/web/public/styles.css
git commit -m "feat: frontend HTML shell and terminal dark theme CSS"
```

---

### Task 7: Frontend — Client-Side JavaScript (Session List + Debate Viewer)

**Files:**
- Create: `src/web/public/app.js`

- [ ] **Step 1: Write app.js — WebSocket connection and session list rendering**

Create `src/web/public/app.js` with:

1. **State management:** Simple object holding `{ sessions, currentSessionId, currentMessages, wsConnected }`.

2. **WebSocket connection:**
   - Connect to `ws://${location.host}`
   - Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
   - Message router dispatching to handler functions by `type`

3. **Session list rendering (`renderSessionList`):**
   - Group sessions: "Active" (status === "active") at top, "Recent" for everything else
   - Render each as a clickable item with prompt snippet, status dot, round count, relative time
   - Highlight selected session
   - On click: set `currentSessionId`, fetch `GET /api/sessions/:id`, render debate viewer

4. **Handlers:**
   - `sessions.list` → update state, re-render sidebar
   - `session.updated` → update the matching session in state, re-render sidebar
   - `turn.start` → show typing indicator in debate viewer
   - `turn.complete` → append message to thread, hide typing indicator
   - `debate.result` → show outcome bar, update session status
   - `error` → log to console

- [ ] **Step 2: Write app.js — Debate viewer rendering**

Add to `app.js`:

1. **`renderDebateViewer(meta, messages)`:**
   - Show header with prompt, status badge, action buttons
   - Build convergence progress bar from messages
   - Render each message as a chat-style element with avatar, header, content, artifacts
   - Parse code blocks in message content → wrap in `<pre><code>` with syntax classes
   - Show outcome bar if session is completed/escalated
   - Show guidance input if session is escalated
   - Auto-scroll to bottom

2. **`renderMessage(msg)` helper:**
   - Create DOM elements for avatar, header (agent name, role pill, turn, signal badge), content
   - Detect code fences (` ``` `) in content and render as styled code blocks
   - Render artifact tags as clickable pills

3. **`renderConvergenceBar(messages, guardrailRounds)`:**
   - One segment per message, colored by agent
   - Pending segments for remaining rounds

- [ ] **Step 3: Write app.js — New debate form and debate control**

Add to `app.js`:

1. **New debate button handler:**
   - Show the new debate form, hide the debate viewer
   - Auto-focus the prompt textarea

2. **Start debate handler:**
   - Read prompt + config from form
   - Send `debate.start` via WS (convert timeout seconds → ms on server)
   - Switch to debate viewer in live mode

3. **Guidance submit handler:**
   - Read textarea value
   - Send `debate.steer` via WS
   - Clear input, show typing indicator

4. **Pause/Resume button handlers:**
   - Send `debate.pause` or `debate.resume` via WS

5. **Keyboard shortcut:**
   - `N` key (when not in an input) → open new debate form

- [ ] **Step 4: Build and test manually end-to-end**

```bash
npm run build && node dist/index.js serve
```

Open `http://localhost:4747`. Test:
- Session list loads from existing `~/.topg/sessions/`
- Clicking a session shows the debate viewer with messages
- "New Debate" button shows the form
- Starting a debate shows live turns appearing
- Guidance input appears on escalation

- [ ] **Step 5: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat: frontend client JS — session list, debate viewer, debate control"
```

---

### Task 8: Polish and Integration Test

**Files:**
- Modify: `src/web/public/app.js` (relative time formatting, code block parsing)
- Create: `tests/integration/server-full.test.ts`

- [ ] **Step 1: Add relative time formatting to app.js**

Add a `relativeTime(isoString)` helper that returns "now", "2m ago", "1h ago", "3d ago", etc.

- [ ] **Step 2: Add code fence parsing to message renderer**

In `renderMessage`, detect ` ```lang\n...\n``` ` blocks in `msg.content` and wrap them in `<pre><code class="language-{lang}">` elements.

- [ ] **Step 3: Write integration test**

Create `tests/integration/server-full.test.ts`:

```typescript
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
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("serves index.html and establishes WS connection", async () => {
    server = createTopgServer({ port: 0, sessionManager: session });
    port = await server.start();

    // HTTP works
    const htmlRes = await fetch(`http://localhost:${port}/`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("topg");

    // CSS works
    const cssRes = await fetch(`http://localhost:${port}/styles.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");

    // JS works
    const jsRes = await fetch(`http://localhost:${port}/app.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("text/javascript");

    // WS works
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise((r) => ws.on("open", r));
    const msg = await new Promise<any>((r) =>
      ws.once("message", (d) => r(JSON.parse(d.toString())))
    );
    expect(msg.type).toBe("sessions.list");
    ws.close();
  });
});
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/public/app.js tests/integration/server-full.test.ts
git commit -m "feat: polish frontend, add server integration test"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Build from clean state**

```bash
npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: ALL PASS

- [ ] **Step 3: Manual smoke test**

```bash
node dist/index.js serve
```

Open `http://localhost:4747` and verify:
1. Session list shows existing sessions from `~/.topg/sessions/`
2. Clicking a session loads the debate viewer with full message history
3. Convergence progress bar renders correctly
4. Code blocks are styled
5. "New Debate" form works (if API keys are configured)
6. WebSocket reconnects after briefly stopping/starting the server

- [ ] **Step 4: Verify existing CLI still works**

```bash
node dist/index.js --help
node dist/index.js serve --help
```

Expected: Both commands show correct help. The original `topg "prompt"` and `topg` (REPL) behavior is unchanged.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: topg web dashboard — view, start, and steer agent debates from the browser"
```
