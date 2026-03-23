import { describe, it, expect } from "vitest";
import { formatConsensus, formatEscalation } from "../src/formatter.js";
import type { Message, Artifact, ToolActivity } from "../src/types.js";

describe("formatConsensus", () => {
  it("should format a consensus result", () => {
    const messages: Message[] = [
      {
        role: "initiator",
        agent: "claude",
        turn: 1,
        type: "code",
        content: "Use React with TypeScript for the frontend.",
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "codex",
        turn: 2,
        type: "review",
        content: "I agree. React + TypeScript is the right choice.\n[CONVERGENCE: agree]",
        convergenceSignal: "agree",
        timestamp: new Date().toISOString(),
      },
    ];

    const output = formatConsensus(messages, 2);
    expect(output).toContain("[CONSENSUS after 2 rounds]");
    expect(output).toContain("React");
  });

  it("should include artifacts when present", () => {
    const artifacts: Artifact[] = [{ path: "src/app.tsx", content: "export default App;", type: "code" }];
    const messages: Message[] = [
      {
        role: "initiator",
        agent: "claude",
        turn: 1,
        type: "code",
        content: "Here is the app.",
        artifacts,
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "codex",
        turn: 2,
        type: "consensus",
        content: "LGTM.\n[CONVERGENCE: agree]",
        convergenceSignal: "agree",
        timestamp: new Date().toISOString(),
      },
    ];

    const output = formatConsensus(messages, 2);
    expect(output).toContain("src/app.tsx");
  });
});

describe("formatEscalation", () => {
  it("should format a disagreement report", () => {
    const messages: Message[] = [
      {
        role: "initiator",
        agent: "claude",
        turn: 7,
        type: "deadlock",
        content: "## What we agree on\n- Use TypeScript\n## Where we disagree\n- I prefer React\n## My recommendation\n- Use React",
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "codex",
        turn: 8,
        type: "deadlock",
        content: "## What we agree on\n- Use TypeScript\n## Where we disagree\n- I prefer Vue\n## My recommendation\n- Use Vue",
        timestamp: new Date().toISOString(),
      },
    ];

    const output = formatEscalation(messages, 8);
    expect(output).toContain("[ESCALATION after 8 rounds");
    expect(output).toContain("Claude");
    expect(output).toContain("Codex");
  });
});

describe("formatConsensus with tool activities", () => {
  it("should include tool activity section when messages have tool activities", () => {
    const messages: Message[] = [
      {
        role: "initiator",
        agent: "claude",
        turn: 1,
        type: "code",
        content: "Here is my implementation.",
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "codex",
        turn: 2,
        type: "review",
        content: "Looks good after checking.\n[CONVERGENCE: agree]",
        convergenceSignal: "agree",
        toolActivities: [
          { type: "command_execution", command: "cat src/app.ts", output: "contents", exitCode: 0 },
          { type: "file_change", changes: [{ path: "src/fix.ts", kind: "update" }] },
          { type: "web_search", query: "react best practices 2026" },
        ],
        timestamp: new Date().toISOString(),
      },
    ];

    const output = formatConsensus(messages, 2);
    expect(output).toContain("## Tool Activity");
    expect(output).toContain("cat src/app.ts");
    expect(output).toContain("src/fix.ts");
    expect(output).toContain("react best practices 2026");
  });

  it("should not include tool activity section when no activities", () => {
    const messages: Message[] = [
      {
        role: "initiator",
        agent: "claude",
        turn: 1,
        type: "code",
        content: "Use React.",
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "codex",
        turn: 2,
        type: "review",
        content: "Agreed.\n[CONVERGENCE: agree]",
        convergenceSignal: "agree",
        timestamp: new Date().toISOString(),
      },
    ];

    const output = formatConsensus(messages, 2);
    expect(output).not.toContain("## Tool Activity");
  });
});

describe("formatConsensus prefers initiator message", () => {
  it("should use initiator message instead of reviewer meta-review", () => {
    const messages: Message[] = [
      {
        role: "initiator",
        agent: "claude",
        turn: 1,
        type: "code",
        content: "## Implementation Plan\n\n1. Set up React project\n2. Add TypeScript\n3. Configure routing",
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "codex",
        turn: 2,
        type: "review",
        content: "Your plan is solid. I verified every major claim and found no issues.\n[CONVERGENCE: agree]",
        convergenceSignal: "agree",
        timestamp: new Date().toISOString(),
      },
    ];

    const output = formatConsensus(messages, 2);
    // The "Agreed Approach" section should contain the actual plan from the initiator
    const agreedSection = output.split("## Key Decisions")[0];
    expect(agreedSection).toContain("## Implementation Plan");
    expect(agreedSection).toContain("Set up React project");
    expect(agreedSection).not.toContain("Your plan is solid");
  });

  it("should use the initiating agent's latest message in multi-round debates", () => {
    // Simulates the real orchestrator: only turn 1 has role:"initiator",
    // all subsequent turns have role:"reviewer" regardless of agent.
    const messages: Message[] = [
      {
        role: "initiator",
        agent: "claude",
        turn: 1,
        type: "code",
        content: "Use React.",
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "codex",
        turn: 2,
        type: "review",
        content: "React is fine but add Next.js.\n[CONVERGENCE: partial]",
        convergenceSignal: "partial",
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "claude",
        turn: 3,
        type: "review",
        content: "Agreed. Use React with Next.js for SSR.\n[CONVERGENCE: agree]",
        convergenceSignal: "agree",
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "codex",
        turn: 4,
        type: "review",
        content: "Your revised plan is solid. I verified all claims.\n[CONVERGENCE: agree]",
        convergenceSignal: "agree",
        timestamp: new Date().toISOString(),
      },
    ];

    const output = formatConsensus(messages, 4);
    const agreedSection = output.split("## Key Decisions")[0];
    // Should use claude's turn-3 revision (last message from the initiating agent),
    // NOT codex's turn-4 meta-review, and NOT claude's stale turn-1 answer
    expect(agreedSection).toContain("React with Next.js for SSR");
    expect(agreedSection).not.toContain("Your revised plan is solid");
    expect(agreedSection).not.toMatch(/^.*## Agreed Approach\n\nUse React\.\n/);
  });
});

describe("formatter with user-prompt filtering", () => {
  it("should ignore user-prompt messages in getLastMessagePerAgent", () => {
    const messages: Message[] = [
      {
        role: "initiator",
        agent: "claude",
        turn: 1,
        type: "code",
        content: "Use React with TypeScript for the frontend.",
        timestamp: new Date().toISOString(),
      },
      {
        role: "reviewer",
        agent: "codex",
        turn: 2,
        type: "review",
        content: "I agree. React + TypeScript is the right choice.\n[CONVERGENCE: agree]",
        convergenceSignal: "agree" as const,
        timestamp: new Date().toISOString(),
      },
      {
        role: "initiator",
        agent: "claude",
        turn: 3,
        type: "user-prompt" as const,
        content: "[USER PROMPT #2]: now discuss the database",
        timestamp: new Date().toISOString(),
      },
    ];

    const output = formatConsensus(messages, 2);
    expect(output).toContain("React");
    expect(output).not.toContain("USER PROMPT");
  });
});
