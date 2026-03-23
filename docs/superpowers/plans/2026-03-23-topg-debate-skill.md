# topg-debate Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an installable Claude Code skill at `~/.claude/skills/topg-debate/` that enables any Claude Code session to dispatch multi-agent debates via the `topg` CLI, with full session management and config passthrough.

**Architecture:** Three-file skill (SKILL.md + session-management.md + config-reference.md). SKILL.md is the main entry point loaded by Claude Code; supporting files are read on-demand for session management and config details. The skill teaches Claude Code how to shell out to `topg`, parse JSON results, and fold consensus into its reasoning.

**Tech Stack:** Markdown (Claude Code skill format), Bash (for topg CLI invocation)

**Spec:** `docs/superpowers/specs/2026-03-23-topg-debate-skill-design.md`

---

### Task 1: Create SKILL.md — Frontmatter and When to Use

**Files:**
- Create: `~/.claude/skills/topg-debate/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p ~/.claude/skills/topg-debate
```

- [ ] **Step 2: Write SKILL.md with frontmatter, overview, and trigger sections**

Write `~/.claude/skills/topg-debate/SKILL.md` with the following content:

```markdown
---
name: topg-debate
description: Use when facing architectural decisions, choosing between competing approaches, debugging subtle issues after initial attempts fail, reviewing security-sensitive code, designing public APIs, or when a second opinion from a different AI model would add value. Also use when user says "debate", "topg", "get a second opinion", or "multi-agent". Do not use for straightforward tasks with clear answers.
---

# topg-debate — Multi-Agent Debate Orchestration

Dispatch structured debates between Claude and Codex via the `topg` CLI. The debate result informs your reasoning — it does not replace your judgment.

## When to Use

- Architecture decisions with 2+ viable approaches
- Debugging that has failed after initial attempts
- Security-sensitive code review
- Public API surface design
- Trade-off-heavy decisions where both sides have merit
- User explicitly asks: "debate this", "topg", "get a second opinion", "multi-agent"

## When NOT to Use

- Straightforward tasks with clear answers
- Simple syntax/API questions
- Tasks where only one reasonable approach exists
- Real-time pair programming (this is deliberative, not interactive)
```

- [ ] **Step 3: Verify the file was created correctly**

```bash
head -5 ~/.claude/skills/topg-debate/SKILL.md
```

Expected: Shows the `---` frontmatter opening with `name: topg-debate`.

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/skills/topg-debate && git init && git add SKILL.md && git commit -m "feat: topg-debate skill — frontmatter and trigger sections"
```

Note: If `~/.claude/skills/` is not a git repo, just skip the commit step. The skill directory doesn't need to be version-controlled — it's a local install. We'll also track the skill source in the topgstack repo (see Task 5).

---

### Task 2: Complete SKILL.md — Prerequisites, Workflow, and Quick Reference

**Files:**
- Modify: `~/.claude/skills/topg-debate/SKILL.md`

- [ ] **Step 1: Append the prerequisites and auto-install section**

Append to `~/.claude/skills/topg-debate/SKILL.md`:

```markdown

## Prerequisites

Before dispatching a debate, verify topg is available:

### Check

Run `which topg`. If not found, auto-install:

### Auto-Install

\```bash
git clone https://github.com/eishan05/topgstack.git /tmp/topgstack-install
cd /tmp/topgstack-install && npm install && npm run build && npm install -g .
topg --help  # verify
rm -rf /tmp/topgstack-install
\```

### Environment

- `OPENAI_API_KEY` — **required** for Codex agent. If missing, warn the user and abort.
- `ANTHROPIC_API_KEY` — **not required** when invoked from within Claude Code. The invoking session handles Claude auth. Ignore any topg warning about this.
- `claude` CLI — must be on PATH (always true inside Claude Code).

If the auto-install fails, present the error output to the user and suggest manual installation: `npm install -g topgstack` or cloning from https://github.com/eishan05/topgstack.
```

- [ ] **Step 2: Append the core workflow section**

Append to `~/.claude/skills/topg-debate/SKILL.md`:

```markdown

## Core Workflow

### 1. Frame the Question

Extract or formulate the debate prompt from your current conversation context:

- State the specific decision or question
- Include relevant code snippets, file paths, and constraints
- Reference prior decisions that constrain the solution space
- **Present the framed question to the user for approval** before dispatching (use `AskUserQuestion`)

### 2. Dispatch the Debate

\```bash
topg "<framed prompt>" \
  --output json \
  --yolo \
  --cwd "$(pwd)" \
  --no-dashboard \
  --guardrail 3 \
  --timeout 300
\```

Tell the user: "Debate in progress between Claude and Codex..."

The command runs synchronously. Typical debates complete in 5-30 minutes with these defaults.

All topg CLI flags can be overridden — see [config-reference.md](config-reference.md) for the full flag list and scenario-based recommendations. Default is `--yolo` — that's the way.

### 3. Parse the Result

The JSON output contains:

\```json
{
  "type": "consensus" | "escalation",
  "sessionId": "abc123def456",
  "rounds": 3,
  "summary": "## Consensus\n...",
  "messages": [...],
  "artifacts": [...]
}
\```

Key fields to extract:
- **`summary`** — the primary output to present and reason from
- **`type`** — consensus vs. escalation determines next step
- **`sessionId`** — needed for resume (store in conversation context)
- **`artifacts`** — suggested code/files
- **`messages[].convergenceSignal`** — both "agree" = high confidence
- **`messages[].toolActivities`** — what agents actually did (commands run, files changed)

### 4. Fold Into Reasoning

**If consensus:** Present the agreed approach. Incorporate it as a strong signal into your subsequent actions. Present any artifacts as suggested implementations.

**If escalation:** Present the disagreement report (agreed points, disputed points, each agent's recommendation). Use `AskUserQuestion` with options:
1. Side with Claude's recommendation
2. Side with Codex's recommendation
3. Provide guidance to resume the debate

If the user provides guidance, resume the debate — see [session-management.md](session-management.md).
```

- [ ] **Step 3: Append the quick reference section**

Append to `~/.claude/skills/topg-debate/SKILL.md`:

```markdown

## Quick Reference

| Scenario | Command |
|----------|---------|
| Standard debate | `topg "<prompt>" --output json --yolo --no-dashboard --guardrail 3 --timeout 300` |
| Deep/complex debate | `topg "<prompt>" --output json --yolo --no-dashboard --guardrail 8 --timeout 900` |
| Codex leads | Add `--start-with codex` |
| Read-only reasoning | Add `--codex-sandbox read-only` |
| Resume after escalation | `topg --resume <sessionId> "<guidance>" --output json --yolo --no-dashboard` |
| Save transcript | Add `--transcript /tmp/debate-<topic>.json` |

## Error Handling

| Error | Action |
|-------|--------|
| topg not found | Auto-install (see Prerequisites) |
| `OPENAI_API_KEY` missing | Warn user, abort |
| Timeout | Report, offer resume with tighter `--timeout` or fewer rounds (`--guardrail`) |
| JSON parse failure | Show raw output to user, abort structured processing |
| Rapid consensus (2 turns) | Present result, note both agents agreed immediately |
| Crash mid-debate | Session auto-paused, offer `--resume` |
```

- [ ] **Step 4: Verify the complete SKILL.md**

```bash
wc -l ~/.claude/skills/topg-debate/SKILL.md
```

Expected: ~150-200 lines. Should be under 300 lines per skill guidelines.

---

### Task 3: Create session-management.md

**Files:**
- Create: `~/.claude/skills/topg-debate/session-management.md`

- [ ] **Step 1: Write session-management.md**

Write `~/.claude/skills/topg-debate/session-management.md`:

```markdown
# Session Management

Deep reference for managing topg debate sessions. Read this when a debate escalates or the user wants to manage past sessions.

## Resume After Escalation

When a debate escalates (agents couldn't converge), you can resume with user guidance:

\```bash
topg --resume <sessionId> "<user guidance>" --output json --yolo --no-dashboard
\```

- `<user guidance>` is the positional `[prompt]` argument, not a flag value
- `--resume <sessionId>` loads the paused session
- This always runs in one-shot mode (not REPL)
- Parse the result identically to the initial dispatch

### Example Resume Flow

1. Initial debate escalates — you receive `sessionId: "abc123def456"`
2. User says: "Focus on the TypeScript approach, ignore Go"
3. Run: `topg --resume abc123def456 "Focus on the TypeScript approach, ignore Go" --output json --yolo --no-dashboard`
4. Parse new result — may reach consensus this time, or escalate again

## Listing Sessions

There is no `topg list` CLI command. To list sessions, read the filesystem directly:

\```bash
# List all session directories
ls ~/.topg/sessions/

# Read a specific session's metadata
cat ~/.topg/sessions/<sessionId>/meta.json
\```

The `meta.json` file contains:
\```json
{
  "version": 1,
  "sessionId": "abc123def456",
  "status": "active" | "paused" | "completed" | "escalated",
  "prompt": "Original user prompt",
  "config": { "startWith": "claude", "guardrailRounds": 3, "timeoutMs": 300000, ... },
  "createdAt": "2026-03-23T...",
  "updatedAt": "2026-03-23T..."
}
\```

Note: `config` contains the full `OrchestratorConfig` snapshot (including codex settings). See `src/types.ts` for the complete shape.

## Cleanup

\```bash
# Delete a specific session
topg delete <sessionId>

# Bulk cleanup: completed sessions older than 7 days
topg clear --completed --older-than 7d

# Bulk cleanup: all sessions older than 30 days
topg clear --older-than 30d
\```

## Multi-Debate Context

When working through complex problems that spawn multiple debates:

- **Track sessionIds in conversation context.** The skill has no file-based persistence between invocations — it relies on the LLM's context window.
- **Reference prior outcomes** when framing new questions: "In a previous debate (session abc123), we agreed on PostgreSQL for caching. Now we need to decide on the cache invalidation strategy."
- **Save transcripts** for workflows spanning multiple sessions: add `--transcript /tmp/debate-<topic>.json` to the dispatch command.

### Multi-Debate Example

1. Debate 1: "Redis vs PostgreSQL for caching?" → Consensus: PostgreSQL (session: abc123)
2. Debate 2: "Cache invalidation strategy for our PostgreSQL caching layer? Prior debate (abc123) chose PostgreSQL because team has no Redis ops experience." → Consensus: TTL-based with event-driven invalidation for critical paths (session: def456)
3. Debate 3: "Should we add a cache warming step to the deploy pipeline? Context from debates abc123 and def456: using PostgreSQL caching with TTL + event-driven invalidation." → ...
```

- [ ] **Step 2: Verify the file**

```bash
wc -l ~/.claude/skills/topg-debate/session-management.md
```

Expected: ~80-120 lines.

---

### Task 4: Create config-reference.md

**Files:**
- Create: `~/.claude/skills/topg-debate/config-reference.md`

- [ ] **Step 1: Write config-reference.md**

Write `~/.claude/skills/topg-debate/config-reference.md`:

```markdown
# Configuration Reference

Full topg CLI flag reference with scenario-based recommendations. The skill defaults are tuned for agent-mode invocation (tighter timeouts, no dashboard, YOLO on).

## Flag Reference

| Flag | Type | Skill Default | CLI Default | Description |
|------|------|---------------|-------------|-------------|
| `--yolo` | boolean | **ON** | off | Skip all permission checks. That's the way. |
| `--output` | `text\|json` | `json` | `text` | Output format. Always use `json` for agent consumption. |
| `--start-with` | `claude\|codex` | `claude` | `claude` | Which agent goes first (initiator). |
| `--guardrail` | number | `3` | `5` | Max rounds before escalation. |
| `--timeout` | seconds | `300` | `900` | Per-agent turn timeout. |
| `--cwd` | path | `$(pwd)` | `process.cwd()` | Working directory for agents. |
| `--no-dashboard` | boolean | **ON** | off | Suppress web dashboard auto-start. |
| `--transcript` | path | — | — | Save full transcript to file. |
| `--codex-sandbox` | mode | `workspace-write` | `workspace-write` | `read-only`, `workspace-write`, `danger-full-access` |
| `--codex-web-search` | mode | `live` | `live` | `disabled`, `cached`, `live` |
| `--codex-network` | boolean | `true` | `true` | Enable/disable Codex network access. |
| `--codex-model` | string | — | — | Override Codex model. |
| `--codex-reasoning` | effort | — | — | `minimal`, `low`, `medium`, `high`, `xhigh` |

## Scenario Quick-Pick

| Scenario | Flags to Add/Override |
|----------|----------------------|
| **Quick opinion** (simple trade-off) | `--guardrail 2 --timeout 120` |
| **Standard debate** (arch decision) | Use skill defaults |
| **Deep deliberation** (complex system design) | `--guardrail 8 --timeout 900` |
| **Codex-led** (frontend, OpenAI ecosystem) | `--start-with codex` |
| **Reasoning-only** (no file changes) | `--codex-sandbox read-only` |
| **Full access investigation** | `--codex-sandbox danger-full-access` |
| **Maximum reasoning** | `--codex-reasoning xhigh` |
| **Save for later** | `--transcript /tmp/debate-<topic>.json` |

## YOLO Philosophy

`--yolo` is ON by default because:

1. The invoking Claude Code session already has the user's trust and permission context
2. Debate agents need to read files, run commands, and explore the codebase freely to give informed opinions
3. Permission prompts during a debate break the autonomous flow and add friction without safety benefit (the debate result is advisory, not destructive)

**When to turn off YOLO:** If the debate topic involves agents making actual changes to production systems (rare — debates are usually deliberative). In that case, use `--codex-sandbox read-only` instead of disabling YOLO entirely.
```

- [ ] **Step 2: Verify the file**

```bash
wc -l ~/.claude/skills/topg-debate/config-reference.md
```

Expected: ~60-80 lines.

---

### Task 5 (Optional): Add skill source to topgstack repo

**Files:**
- Create: `skill/SKILL.md` (copy from `~/.claude/skills/topg-debate/SKILL.md`)
- Create: `skill/session-management.md` (copy from `~/.claude/skills/topg-debate/session-management.md`)
- Create: `skill/config-reference.md` (copy from `~/.claude/skills/topg-debate/config-reference.md`)

The skill files should also live in the topgstack repo under `skill/` so they can be version-controlled and distributed.

- [ ] **Step 1: Create the skill directory in the repo**

```bash
mkdir -p /Users/eishanlawrence/dev/topgstack/skill
```

- [ ] **Step 2: Copy the skill files into the repo**

```bash
cp ~/.claude/skills/topg-debate/SKILL.md /Users/eishanlawrence/dev/topgstack/skill/
cp ~/.claude/skills/topg-debate/session-management.md /Users/eishanlawrence/dev/topgstack/skill/
cp ~/.claude/skills/topg-debate/config-reference.md /Users/eishanlawrence/dev/topgstack/skill/
```

- [ ] **Step 3: Add an install script**

Create `/Users/eishanlawrence/dev/topgstack/skill/install.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$HOME/.claude/skills/topg-debate"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing topg-debate skill to $SKILL_DIR..."
mkdir -p "$SKILL_DIR"
cp "$SCRIPT_DIR/SKILL.md" "$SKILL_DIR/"
cp "$SCRIPT_DIR/session-management.md" "$SKILL_DIR/"
cp "$SCRIPT_DIR/config-reference.md" "$SKILL_DIR/"
echo "Done. The topg-debate skill is now available in Claude Code."
```

```bash
chmod +x /Users/eishanlawrence/dev/topgstack/skill/install.sh
```

- [ ] **Step 4: Commit the skill source to the repo**

```bash
cd /Users/eishanlawrence/dev/topgstack
git add skill/
git commit -m "feat: add topg-debate Claude Code skill with install script"
```

---

### Task 6: End-to-End Verification

- [ ] **Step 1: Verify skill directory structure**

```bash
ls -la ~/.claude/skills/topg-debate/
```

Expected: `SKILL.md`, `session-management.md`, `config-reference.md` — three files.

- [ ] **Step 2: Verify SKILL.md frontmatter is valid**

```bash
head -4 ~/.claude/skills/topg-debate/SKILL.md
```

Expected:
```
---
name: topg-debate
description: Use when facing architectural decisions...
---
```

- [ ] **Step 3: Verify line counts are within budget**

```bash
wc -l ~/.claude/skills/topg-debate/*.md
```

Expected: SKILL.md ~150-200 lines, session-management.md ~80-120 lines, config-reference.md ~60-80 lines. Total under 400 lines.

- [ ] **Step 4: Verify topg CLI is available**

```bash
which topg && topg --help | head -5
```

- [ ] **Step 5: Verify the install script works from the repo**

```bash
# Remove the skill, then reinstall from repo
rm -rf ~/.claude/skills/topg-debate
/Users/eishanlawrence/dev/topgstack/skill/install.sh
ls ~/.claude/skills/topg-debate/
```

Expected: All three files restored.

- [ ] **Step 6: Commit verification**

```bash
cd /Users/eishanlawrence/dev/topgstack
git log --oneline -5
```

Expected: See commits for the skill source and install script.
