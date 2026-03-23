# Open PR Reviews

*Reviewed: 2026-03-23*

---

## 1. `feat/codex-full-capabilities` (PR #1 — merged)

**Summary:** Unlocks full Codex SDK capabilities — adds `CodexConfig` type, wires config through CLI/REPL/server, enables web search and network access by default, tracks tool activity (commands, file changes, web searches, MCP calls), and formats tool activity in consensus/escalation output.

**Files:** 12 files, +544/-29 lines

### Key Issues

| Severity | Issue |
|----------|-------|
| Bug | `networkAccessEnabled: false` silently ignored — property omitted instead of explicitly set, so SDK default may override |
| Bug | `webSearchMode: "disabled"` omits the field entirely — same SDK-default concern |
| Bug | No CLI flag validation for `--codex-sandbox` and `--codex-reasoning` — typos silently pass invalid values |
| Quality | `DEFAULT_CODEX_CONFIG` exported but unused — defaults duplicated in constructor |
| Quality | `Object.assign` mutation in `updateConfig()` — should use spread to avoid shared-reference bugs |
| Quality | `any` types in `buildMessage` bypass type checking |

### Suggestions
- Use `DEFAULT_CODEX_CONFIG` in constructor instead of duplicating defaults
- Add Commander `.choices()` validation for enum CLI flags
- Explicitly set all thread options regardless of value
- Truncate long tool activity output in formatted summaries

---

## 2. `feat/improve-prompting` (PR #2 — merged)

**Summary:** Four improvements: (1) rewritten structured prompts for initiator/reviewer/rebuttal, (2) parallel escalation via `Promise.allSettled` eliminating sequential bias, (3) history summarization with XML-delimited turns when history exceeds 8 messages, (4) new `user-guidance` message type to distinguish user interjections.

**Files:** 6 files, +520/-116 lines

### Key Issues

| Severity | Issue |
|----------|-------|
| Bug | Abort detection relies on exact string `"aborted"` — brittle if SDK changes error message |
| Bug | Synthetic fallback `AgentResponse` in `runEscalation` may be missing required fields beyond `content` |
| Quality | Dead variable `label` in `summarizeHistory` loop — computed but never used |
| Quality | `onTurnStart` semantics changed — both fire simultaneously in parallel escalation vs. sequentially before |
| Quality | `HISTORY_SUMMARIZE_THRESHOLD = 8` is not configurable |

### Suggestions
- Use `signal?.aborted` or `err.name === "AbortError"` instead of string matching
- Remove the dead `label` variable
- Make summarization threshold configurable via `OrchestratorConfig`
- Build synthetic fallback responses using a helper that matches the full `AgentResponse` type

---

## 3. `feat/repl-dashboard-autostart`

**Summary:** Auto-starts the web dashboard on an ephemeral port when the REPL launches. Prints URL in welcome banner, adds `/dashboard` command, broadcasts WebSocket events for real-time dashboard updates, cleans up server on exit.

**Files:** 1 file, +52/-16 lines

### Key Issues

| Severity | Issue |
|----------|-------|
| Bug | `server.start()` failure is unhandled — will crash the REPL if port binding fails |
| Bug | `server.close()` called twice on SIGINT (once in handler, again in readline `close` event triggered by `process.exit`) |
| Design | No opt-out mechanism (`--no-dashboard`) — auto-starting a web server may be unexpected in CI/containers |

### Suggestions
- Wrap `server.start()` in try/catch so dashboard failure doesn't block REPL
- Make `server.close()` idempotent or guard against double-close
- Add `--no-dashboard` CLI flag
- Add explicit `: OrchestratorCallbacks` type annotation to the callbacks object

---

## 4. `feat/session-cleanup`

**Summary:** Adds `topg delete <sessionId>` and `topg clear` CLI subcommands for session management. Supports filters (`--all`, `--completed`, `--escalated`, `--older-than`), interactive confirmation, path traversal protection, and comprehensive tests.

**Files:** 3 files, 2 commits

### Key Issues

| Severity | Issue |
|----------|-------|
| Minor | `askUser` hangs on non-TTY stdin (piped input without `--force`) |
| Minor | `delete` command doesn't warn when deleting active/paused sessions |
| Minor | `parseDuration` uses 30-day months — not documented to user |

### Suggestions
- Add `--dry-run` to `clear` command
- Guard `delete` against active sessions (require `--force`)
- Add hours (`h`) unit to `parseDuration`
- Document "1m = 30 days" in help text

**Verdict:** Well-structured, well-tested. No blockers.

---

## 5. `feat/stream-responses`

**Summary:** Adds real-time streaming of model responses to the web dashboard. Switches Claude adapter to `stream-json` output format, parses NDJSON, broadcasts `turn.chunk` WebSocket events, renders streaming text with blinking cursor animation.

**Files:** 7 files

### Key Issues

| Severity | Issue |
|----------|-------|
| Bug | `resume()` and `continueWithGuidance()` don't pass chunk callback — streaming silently broken for those paths |
| Bug | `lineBuffer` residual data silently discarded on process close — could miss final event |
| Bug | Streaming state not cleared on session switch — orphaned DOM elements possible |
| Bug | XSS risk via `innerHTML` with `parseContent()` — not a regression but streaming makes it continuous |
| Quality | `onChunk` as 4th positional parameter after optional `signal` — fragile, should use options object |

### Suggestions
- Wire streaming into all orchestration paths (`resume`, `continueWithGuidance`, `synthesize`)
- Flush `lineBuffer` on process close
- Throttle DOM updates with `requestAnimationFrame` or debounce
- Refactor `send()` to use an options bag pattern
- Clear streaming state on session switch

---

## 6. `feat/yolo-mode` (PR #3 — merged)

**Summary:** Adds `--yolo` flag that disables all permission checks: Claude gets `--dangerously-skip-permissions`, Codex gets `danger-full-access` sandbox mode. Includes server-side config injection protection and session resume drift prevention.

**Files:** 6 files, +99/-21 lines

### Key Issues

| Severity | Issue |
|----------|-------|
| Bug | Server-side `approvalPolicy` stripping is too aggressive — blocks all values, not just dangerous ones |
| Bug | `--yolo` may be a no-op in server mode for WebSocket-initiated debates |
| Quality | Yolo-override logic duplicated 3 times — should be extracted to helper |
| Quality | `CodexAdapter` constructor duplicates config fields in if/else branches |
| Quality | No test coverage for any yolo behavior |

### Suggestions
- Add tests for yolo mode (adapter behavior, server config stripping, session resume)
- Extract shared yolo-override helper
- Filter only dangerous `approvalPolicy` values, not all values
- Consider interactive confirmation for `--yolo` (skippable with `--yes`)

---

## 7. `fix/synthesis-step`

**Summary:** Adds a synthesis step after consensus — sends the full debate transcript back to the initiator agent for a clean, consolidated final answer. Falls back to improved `formatConsensus()` if synthesis fails. Extracts `capitalize()` to shared utils.

**Files:** 5 files, 3 commits

### Key Issues

| Severity | Issue |
|----------|-------|
| Quality | Consensus-building pattern (`synthesize || formatConsensus`) duplicated 4 times across orchestrator methods |
| Bug | Synthesis prompt sent twice — once as system prompt, once in the user message |
| Minor | Empty `sessionId: ""` passed to synthesis call — could affect logging/tracking |
| Minor | Abort detection relies on exact string `"aborted"` (same pattern as feat/improve-prompting) |

### Suggestions
- Extract `buildConsensusSummary()` private method
- Remove duplicate synthesis prompt (use either system prompt or user message, not both)
- Pass real session ID or document why empty string is intentional
- Consider skipping synthesis for trivial 2-turn agreements to save cost

**Verdict:** Well-executed with thorough test coverage and good commit discipline. No blockers.

---

## Cross-Cutting Themes

1. **Brittle abort detection**: Multiple branches use `err.message === "aborted"` string matching. Should standardize on `signal?.aborted` or `err.name === "AbortError"`.

2. **Code duplication in orchestrator**: Both `fix/synthesis-step` and `feat/stream-responses` add logic that must be repeated across `run()`, `runWithHistory()`, `resume()`, and `continueWithGuidance()`. Consider refactoring these four methods to share a common execution core.

3. **Options bag pattern needed**: Multiple adapters use positional optional parameters that lead to `undefined` placeholders. An options object pattern would be more maintainable.

4. **Missing test coverage for security-sensitive features**: `feat/yolo-mode` has zero tests despite disabling all safety guardrails.

5. **SDK default assumptions**: `feat/codex-full-capabilities` omits config fields instead of explicitly setting them, relying on undocumented SDK defaults.
