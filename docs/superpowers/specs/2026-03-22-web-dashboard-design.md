# topg Web Dashboard — Design Spec

## Overview

Add a `topg serve` command that starts a local web server, providing a browser-based dashboard for viewing debates, starting new ones, and providing guidance — a full alternative to the CLI REPL.

### Goals

- Browse and inspect past debate sessions
- Watch live debates unfold in real-time
- Start new debates, pause/resume, and submit guidance from the browser
- Ship as part of the open-source package (no separate install)
- Minimal dependencies, consistent with topgstack's lean philosophy

### Non-Goals

- Multi-user / remote access (this is a local dev tool)
- Database or separate storage layer (filesystem is source of truth)
- Frontend build step (no bundler, no JSX, no compilation)

## Architecture

### Server (`src/server.ts`)

A single Node.js process using `node:http` for HTTP and `ws` for WebSockets.

```
topg serve [:port]
       │
       ▼
┌─────────────────────────────────────┐
│         node:http server            │
│                                     │
│  Static files ← src/web/public/    │
│  REST API     ← SessionManager      │
│  WS upgrade   ← ws.Server          │
└──────────┬──────────────────────────┘
           │
     ┌─────┴──────┐
     │  WebSocket  │
     │  handlers   │
     └─────┬──────┘
           │
  ┌────────┴────────┐
  │  Orchestrator    │ (reused, with new onTurnComplete callback)
  │  SessionManager  │ (reused as-is)
  │  ClaudeAdapter   │ (reused)
  │  CodexAdapter    │ (reused)
  └─────────────────┘
```

**Responsibilities:**

1. Serve static files from `src/web/public/` (index.html, styles.css, app.js)
2. Expose read-only REST endpoints for initial data loading
3. Handle WebSocket connections for real-time bidirectional communication
4. Create and manage Orchestrator instances for active debates
5. Broadcast debate events to all connected WebSocket clients

### REST Endpoints (read-only, for initial page load)

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/` | `index.html` |
| `GET` | `/api/sessions` | `SessionMeta[]` |
| `GET` | `/api/sessions/:id` | `{ meta: SessionMeta, messages: Message[] }` |
| `GET` | `/*` | Static file from `src/web/public/` |

### WebSocket Protocol

All messages are JSON with a `type` field.

**Client → Server:**

```typescript
// Start a new debate
{ type: "debate.start", prompt: string, config?: Partial<OrchestratorConfig> }

// Submit guidance for an escalated debate
{ type: "debate.steer", sessionId: string, guidance: string }

// Pause an active debate
{ type: "debate.pause", sessionId: string }

// Resume a paused debate (without guidance — re-enters review loop from where it left off)
{ type: "debate.resume", sessionId: string }
```

**`debate.resume` vs `debate.steer`:** These map to different Orchestrator methods. `debate.resume` calls `orchestrator.resume(sessionId)` which re-enters the review loop from the last turn. `debate.steer` calls `orchestrator.continueWithGuidance()` which injects user guidance as a special message and restarts the debate loop with that context. Use `debate.resume` for paused sessions, `debate.steer` for escalated sessions where the user wants to redirect the agents.

**Server → Client:**

```typescript
// Sent on connection and when sessions change
{ type: "sessions.list", sessions: SessionMeta[] }

// Session metadata updated (status change, etc.)
{ type: "session.updated", session: SessionMeta }

// An agent turn has started (for spinner/progress)
{ type: "turn.start", sessionId: string, turn: number, agent: AgentName, role: string }

// An agent turn completed with its message
{ type: "turn.complete", sessionId: string, message: Message }

// Debate finished (consensus or escalation)
{ type: "debate.result", sessionId: string, result: OrchestratorResult }

// Error
{ type: "error", code: string, message: string }
```

### Orchestrator Changes

The existing `Orchestrator` class has a `TurnCallback` (`onTurnStart`) but no callback for turn completion. We add one:

```typescript
export type TurnCompleteCallback = (message: Message) => void;
```

**Integration approach:** Rather than adding a 6th positional constructor parameter, refactor the callback parameters into an options object:

```typescript
interface OrchestratorCallbacks {
  onTurnStart?: TurnCallback;
  onTurnComplete?: TurnCompleteCallback;
}

constructor(
  agentA: AgentAdapter,
  agentB: AgentAdapter,
  session: SessionManager,
  config: OrchestratorConfig,
  callbacks?: OrchestratorCallbacks
)
```

The `onTurnComplete` callback fires in **all four debate methods** — `run()`, `runWithHistory()`, `resume()`, and `continueWithGuidance()` — immediately after each call to `session.appendMessage()`. This is critical because the server uses `runWithHistory()` for new debates (to support message history) and `continueWithGuidance()` for the `debate.steer` handler. All paths must emit turn completion events for the WebSocket broadcast to work correctly.

### CLI Integration

The existing `src/index.ts` uses Commander's root command with a positional `[prompt]` argument and `.action()`. Adding `serve` as a Commander subcommand (via `program.command("serve")`) would conflict with the positional argument parsing.

**Approach:** Add `serve` as a proper Commander subcommand. This requires restructuring `index.ts` so the existing one-shot/REPL logic moves into its own subcommand (or remains as the default action). Commander supports both subcommands and a default action — the key is to register `serve` before the catch-all `.argument("[prompt]")` so it gets matched first.

```
topg serve [--port <number>]    # starts web dashboard
topg "some prompt"              # one-shot mode (existing)
topg                            # REPL mode (existing)
```

- Default port: `4747`
- Starts only the web server (no REPL)
- Prints the URL to stderr on startup
- Shuts down cleanly on SIGINT

**Static file MIME types:** The `node:http` static file server must set `Content-Type` headers correctly. At minimum: `.html` → `text/html`, `.css` → `text/css`, `.js` → `text/javascript`. Browsers will refuse to execute JS served without the correct MIME type.

## Frontend

### Tech Stack

- Vanilla HTML, CSS, JavaScript — no framework, no build step
- Terminal-inspired dark theme (monospace, dark background, green/purple accents)
- Single WebSocket connection for all real-time communication

### File Structure

```
src/web/public/
├── index.html     # SPA shell, sidebar + main layout
├── styles.css     # Terminal-themed dark styles
└── app.js         # Client logic: WS, DOM rendering, state
```

### Layout

Persistent **sidebar + main content** layout (no page-level routing):

- **Left sidebar (280px):** logo, "New Debate" button, session list (always visible)
- **Right main area:** debate viewer, new debate form, or empty state

Clicking a session in the sidebar loads it in the main area. This avoids full-page navigation and keeps context visible.

### Sidebar

- **Header:** topg logo/wordmark, version number, "New Debate" button with keyboard shortcut hint (N)
- **Session list:** grouped by status ("Active" at top, then "Recent"), scrollable
  - Each item shows: prompt snippet (2-line clamp), status dot, round count, relative timestamp
  - Status dots: `active` (blue, pulsing animation), `completed` (green), `escalated` (amber), `paused` (gray)
  - Selected session has highlighted background and subtle border
  - Real-time updates via WebSocket (new sessions appear, statuses change, active dots pulse)

### Main Area: Debate Viewer

The core view. Loads when a session is selected in the sidebar.

- **Header bar:** prompt text, status badge ("consensus" / "escalated" / etc.), action buttons (Pause, Artifacts)
- **Convergence progress bar:** horizontal track showing each turn as a segment, colored by agent (Claude = purple, Codex = green). Pending turns are dim. Shows "N/M rounds" label.
- **Message thread:** scrollable, chat-style messages:
  - Each message has an **agent avatar** (square, 32px, with initial — "C" for Claude, "Cx" for Codex) with agent-colored background
  - **Message header:** agent name (colored), role label (pill), turn number, convergence signal badge (right-aligned)
  - **Message content:** prose with code blocks in `<pre><code>` with syntax-colored tokens
  - **Artifact tags:** inline clickable pills below content (e.g., "rate-limiter.ts")
  - Signal badges: agree (green), disagree (red), partial (amber)
- **Live mode:** when a debate is active, a typing indicator (animated dots) appears at the bottom with the current agent's name
- **Outcome bar (bottom):**
  - Consensus: green-tinted bar with checkmark, "Consensus reached", round count + artifact count + duration
  - Escalation: amber-tinted bar with warning icon
- **Guidance input (escalated sessions):** textarea + "Send" button at the bottom, replaces outcome bar

### Main Area: New Debate

Shown when the "New Debate" button is clicked. Replaces the debate viewer in the main area.

- Prompt textarea (auto-focused)
- Config options (collapsible "Advanced" section):
  - Start with: Claude / Codex toggle
  - Guardrail rounds: number input (default 5)
  - Timeout per turn: number input in seconds (default 900)
- "Start Debate" button → sends `debate.start` via WS, loads the debate viewer with live mode
- **Note:** The frontend displays timeout in seconds but `OrchestratorConfig.timeoutMs` expects milliseconds. The `debate.start` handler on the server converts `seconds * 1000` before passing to the Orchestrator.

### Styling

Terminal-inspired dark theme:

- Background: `#0d1117` (GitHub dark)
- Surface: `#161b22`
- Border: `#21262d`
- Text: `#c9d1d9`
- Muted: `#8b949e`
- Claude accent: `#bc8cff` (purple)
- Codex accent: `#7ee787` (green)
- Link/action: `#58a6ff`
- Warning: `#d29922`
- Error: `#f85149`
- Font: `'Courier New', 'Consolas', monospace`
- No rounded corners beyond 6px, no shadows, no gradients

## Data Flow

### Viewing a Past Session

1. Browser loads `index.html`, which loads `app.js`
2. `app.js` connects WebSocket, receives `sessions.list`
3. User clicks a session → hash changes to `#/sessions/:id`
4. `app.js` fetches `GET /api/sessions/:id` for full message history
5. Renders the message thread

### Watching a Live Debate

1. User starts a debate via the "New Debate" form
2. Browser sends `{ type: "debate.start", prompt: "..." }` via WS
3. Server creates Orchestrator with `onTurnStart` and `onTurnComplete` callbacks
4. Callbacks broadcast `turn.start` and `turn.complete` to all connected WS clients
5. Browser appends each message to the thread as it arrives
6. On completion, server sends `debate.result`, browser shows consensus/escalation bar

### Resuming a Paused Debate

1. User views a paused session → status badge shows "paused", resume button is visible
2. User clicks "Resume" → browser sends `{ type: "debate.resume", sessionId }`
3. Server calls `orchestrator.resume(sessionId)`, which re-enters the review loop from the last turn
4. Turn events stream via WS as normal
5. On completion, server sends `debate.result`

### Providing Guidance (Escalated Debate)

1. Debate escalates → server sends `debate.result` with `type: "escalation"`
2. Browser shows guidance input at bottom of the debate viewer
3. User types guidance, clicks "Send" → browser sends `{ type: "debate.steer", sessionId, guidance }`
4. Server calls `orchestrator.continueWithGuidance()`, streams new turns via WS
5. Process repeats until consensus or user closes

## File Changes Summary

### New Files

| File | Purpose | Estimated Size |
|------|---------|---------------|
| `src/server.ts` | HTTP + WS server, routing, WS handlers | ~250 lines |
| `src/web/public/index.html` | SPA shell with layout | ~80 lines |
| `src/web/public/styles.css` | Terminal dark theme | ~200 lines |
| `src/web/public/app.js` | Client-side routing, WS, DOM | ~400 lines |

### Modified Files

| File | Change |
|------|--------|
| `src/index.ts` | Add `serve` subcommand via Commander |
| `src/orchestrator.ts` | Add optional `onTurnComplete` callback |
| `package.json` | Add `ws` dependency, `@types/ws` dev dependency |

### Dependencies Added

| Package | Type | Size | Purpose |
|---------|------|------|---------|
| `ws` | production | ~50KB | WebSocket server |
| `@types/ws` | dev | — | TypeScript types for `ws` |

## Error Handling

- **WS connection lost:** Client auto-reconnects with exponential backoff (1s, 2s, 4s, max 30s). On reconnect, requests `sessions.list` to resync state.
- **Debate fails mid-run:** Server catches Orchestrator errors, sends `{ type: "error" }` via WS, updates session status to `paused`.
- **Invalid WS message:** Server responds with `{ type: "error", code: "invalid_message" }`, does not disconnect.
- **Port in use:** Server prints error and exits with code 1.
- **Missing API keys:** Same validation as CLI — check for `OPENAI_API_KEY` on startup, warn about `ANTHROPIC_API_KEY`.

## Testing Strategy

- **Server unit tests:** HTTP routing, WS message handling, session API responses
- **Integration test:** Start server, connect WS client, verify message flow for a mock debate
- **Frontend:** Manual testing (no JS test framework for vanilla JS — keep it simple)
