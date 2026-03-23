<p align="center">
  <img src="logo.svg" alt="TOPG" width="280"/>
</p>

<h1 align="center">TOPG</h1>
<h3 align="center">The Top G of AI Agent Frameworks</h3>

Listen. Most developers out there are using ONE AI model like broke people driving a single Honda Civic. They ask Claude a question. They get ONE answer. They accept it like sheep. They never question it. They never challenge it. They live in the matrix.

**TOPG escapes the matrix.**

TOPG throws Claude and Codex into the arena. Two elite AI agents. Head to head. No mercy. They debate, they argue, they tear each other's solutions apart, and what comes out the other side is a battle-tested answer that ACTUALLY WORKS. Because the best ideas don't come from comfort. They come from WAR.

> "If you're making architectural decisions with only one AI, you're mentally broke."

---

## What Is This

TOPG is a TypeScript CLI that orchestrates **turn-based debates between Claude and Codex**. You give it a problem. Both agents fight over the solution. They critique each other's code. They defend their positions. They either converge on the superior answer, or they escalate to you with a structured disagreement report so YOU can be the judge.

This is **intellectual combat**.

```
You: "How should I structure my auth middleware?"

Claude: *proposes solution with trade-offs*
Codex:  *tears it apart, offers counter-proposal*
Claude: *defends position, concedes valid points*
Codex:  *accepts improvements, pushes back on weakness*

→ CONSENSUS REACHED → Battle-tested solution delivered
```

---

## Why You Need This

Because mediocrity is a CHOICE.

- **One model gives you one perspective.** That's a poor person's mindset.
- **Two models debating gives you the TRUTH.** Every weakness gets exposed. Every edge case gets caught. Every lazy shortcut gets called out.
- **Your code gets pressure-tested** before it ever hits production. While other developers are shipping bugs, you're shipping excellence.

Use TOPG for decisions that actually matter:
- Architectural choices
- Security-sensitive code review
- API design
- Complex debugging when you're stuck
- Any decision where being wrong costs you

---

## Installation

Winners move fast.

```bash
npm install
npm run build
```

Set your keys like a professional:
```bash
export ANTHROPIC_API_KEY="your-key"
export OPENAI_API_KEY="your-key"
```

Already paying for Claude Pro/Max or a Codex subscription? **You're already covered.** TOPG works with your existing subscriptions. You're literally leaving money on the table if you're NOT using this.

Think about it. You're paying for TWO of the most powerful AI models on the planet and you're using them ONE AT A TIME like a guy with two Bugattis who only drives on Sundays. That's not hustle. That's waste. That's BROKE behavior with a rich man's credit card.

TOPG makes your subscriptions WORK FOR YOU. While you sleep, while you think, while you sip your coffee, two AI gladiators are in the arena destroying each other's weak arguments so YOU get the strongest answer. That's leverage. That's what separates the Top G from the NPCs.

> "What color is your Bugatti?" Irrelevant. What matters is: are your AI models fighting for you, or are they sitting idle like expensive furniture?

---

## Usage

### One-Shot Mode: Ask and Receive

```bash
topg "Design a rate limiter that handles distributed systems"
```

Both agents fight. You get the winner's answer. Simple.

### REPL Mode: The War Room

```bash
topg
```

Opens an interactive session with a live web dashboard. Watch the debate unfold in real-time like you're ringside at a championship fight.

### Resume a Paused Session

```bash
topg --resume <session-id> "Focus on the caching layer, the DB approach is settled"
```

Come back to a deadlocked debate with fresh guidance. YOU are the top G. You break the tie.

---

## Options

| Flag | What It Does |
|------|-------------|
| `--start-with <claude\|codex>` | Pick who throws the first punch |
| `--guardrail <N>` | Rounds before escalation (default: 5) |
| `--timeout <seconds>` | Per-turn time limit, no stalling |
| `--yolo` | Skip all permission checks. Full send. |
| `--no-dashboard` | No web UI. Raw terminal output only. |
| `--cwd <path>` | Working directory for the agents |

### The `--yolo` Flag

```bash
topg --yolo "Refactor the entire payment system"
```

This is how real G's outside the matrix operate. `--yolo` skips ALL permission checks for both agents. Claude gets `--dangerously-skip-permissions`, Codex gets full sandbox access. No confirmation dialogs. No "are you sure?" popups. No waiting for approval from your corporate overlord to run a command on YOUR computer.

If you need to raise your hand and ask permission to execute code on a machine you own, you are living in the matrix. You are a brokie in the system. You are an NPC.

Real builders ship. `--yolo` lets your agents ship.

---

## How The Debate Works

```
         YOU
          │
          ▼
    ┌───────────┐
    │   TOPG    │
    │ Orchestr. │
    └─────┬─────┘
          │
    ┌─────┴─────┐
    ▼           ▼
 ┌───────┐ ┌───────┐
 │CLAUDE │ │ CODEX │
 │  Agent│ │ Agent │
 └───┬───┘ └───┬───┘
     │         │
     └────┬────┘
          │
   Convergence?
    /          \
  YES           NO
   │             │
   ▼             ▼
CONSENSUS    ESCALATION
 (ship it)   (you decide)
```

1. **Turn 1:** Initiator proposes a solution
2. **Turn 2+:** Reviewer critiques with structured claims
3. **Rebuttals:** Point-by-point responses, no hand-waving
4. **Convergence Detection:** Agreement phrases, structured tags, or diff stability
5. **Resolution:** Either consensus or structured disagreement report

The system tracks individual claims using `[claim-N]` sections so nothing gets lost in the noise. Every point must be addressed. No dodging.

---

## Session Persistence

Every debate is saved. Because winners keep records.

```
~/.topg/sessions/<session-id>/
  ├── meta.json           # Config and status
  ├── transcript.jsonl    # Full debate transcript
  ├── artifacts/          # Code files produced
  └── summary.md          # Final verdict
```

Manage your sessions:
```bash
topg sessions list
topg sessions delete <id>
topg sessions clear --status escalated
```

---

## The Mentality

Most people use AI like consumers. They ask a question, they get an answer, they go home. They never think "what if this answer is wrong?" They never stress-test. They never challenge.

TOPG is for builders who understand that **the best solutions survive criticism**. If your architecture can't withstand scrutiny from a second AI model, it sure as hell won't survive production.

Stop being a one-model developer. **Escape the matrix.**

```bash
topg "your hardest problem here"
```

---

## The Tech Stack

| Component | Choice |
|-----------|--------|
| Language | TypeScript |
| Runtime | Node.js 22+ |
| CLI | Commander.js |
| Claude | Spawns `claude` CLI via stdin |
| Codex | `@openai/codex-sdk` |
| Dashboard | Express + WebSocket |
| Testing | Vitest |

---

## Architecture

```
src/
├── index.ts              # CLI entry, Commander setup
├── orchestrator.ts       # The arena, turn-based debate loop
├── convergence.ts        # Detects when the fight is over
├── adapters/
│   ├── claude-adapter.ts # Claude CLI integration
│   └── codex-adapter.ts  # Codex SDK integration
├── session.ts            # Persistence manager
├── prompts.ts            # System prompts for each role
├── formatter.ts          # Consensus/escalation reports
├── server.ts             # Dashboard HTTP + WebSocket
├── repl.ts               # Interactive mode
└── web/public/           # Dashboard frontend
```

---

## Running Tests

```bash
npm test
```

Tests exist because even the Top G verifies before he ships.

---

## License

Do what you want with it. Winners don't ask for permission.
