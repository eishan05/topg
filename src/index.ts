#!/usr/bin/env node

import { Command } from "commander";
import { Orchestrator } from "./orchestrator.js";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { SessionManager } from "./session.js";
import { startRepl } from "./repl.js";
import { createTopgServer } from "./server.js";
import { askUser, parseDuration } from "./utils.js";
import type { AgentName, CodexConfig, OrchestratorConfig, SessionMeta } from "./types.js";

const program = new Command();

program
  .name("topg")
  .description("Inter-agent collaboration between Claude Code and OpenAI Codex")
  .version("0.1.0");

program
  .command("serve")
  .description("Start the web dashboard")
  .option("--port <number>", "Port to listen on", "4747")
  .action(async (opts) => {
    if (!process.env.OPENAI_API_KEY) {
      console.error("Error: OPENAI_API_KEY is required for Codex.");
      console.error("Set it via: export OPENAI_API_KEY=your-key");
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

program
  .command("delete <sessionId>")
  .description("Delete a single session")
  .action(async (sessionId: string) => {
    const session = new SessionManager();
    try {
      const data = session.load(sessionId);
      const snippet = data.meta.prompt.length > 50
        ? data.meta.prompt.slice(0, 50) + "..."
        : data.meta.prompt;
      session.deleteSession(sessionId);
      console.error(`Deleted session ${sessionId} ("${snippet}")`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("clear")
  .description("Bulk-delete sessions by status or age")
  .option("--all", "Delete all sessions")
  .option("--completed", "Delete completed sessions")
  .option("--escalated", "Delete escalated sessions")
  .option("--older-than <duration>", "Delete sessions not updated within duration (e.g., 7d, 2w, 1m)")
  .option("--force", "Skip confirmation prompt")
  .action(async (opts) => {
    // Validate: at least one filter required
    if (!opts.all && !opts.completed && !opts.escalated && !opts.olderThan) {
      console.error("Error: At least one filter is required (--all, --completed, --escalated, --older-than).");
      console.error("\nExamples:");
      console.error("  topg clear --all                        Delete all sessions");
      console.error("  topg clear --completed                  Delete completed sessions");
      console.error("  topg clear --completed --older-than 7d  Delete completed sessions older than 7 days");
      process.exit(1);
    }

    // Validate: --all cannot combine with other filters
    if (opts.all && (opts.completed || opts.escalated || opts.olderThan)) {
      console.error("Error: --all cannot be combined with --completed, --escalated, or --older-than.");
      process.exit(1);
    }

    const session = new SessionManager();

    let sessions: SessionMeta[];
    if (opts.all) {
      sessions = session.listSessions();
    } else {
      const statuses: SessionMeta["status"][] = [];
      if (opts.completed) statuses.push("completed");
      if (opts.escalated) statuses.push("escalated");

      let olderThan: Date | undefined;
      if (opts.olderThan) {
        const ms = parseDuration(opts.olderThan);
        olderThan = new Date(Date.now() - ms);
      }

      sessions = session.filterSessions({
        statuses: statuses.length > 0 ? statuses : undefined,
        olderThan,
      });
    }

    if (sessions.length === 0) {
      console.error("No sessions match the given filters.");
      return;
    }

    // Show confirmation unless --force
    if (!opts.force) {
      const statusCounts = new Map<string, number>();
      for (const s of sessions) {
        statusCounts.set(s.status, (statusCounts.get(s.status) ?? 0) + 1);
      }
      const breakdown = Array.from(statusCounts.entries())
        .map(([status, count]) => `${count} ${status}`)
        .join(", ");

      console.error(`About to delete ${sessions.length} session${sessions.length === 1 ? "" : "s"}:`);
      console.error(`  ${breakdown}`);
      const answer = await askUser("Continue? (y/N) ");
      if (answer.toLowerCase() !== "y") {
        console.error("Aborted.");
        return;
      }
    }

    // Delete all matched sessions
    for (const s of sessions) {
      session.deleteSession(s.sessionId);
    }
    console.error(`Deleted ${sessions.length} session${sessions.length === 1 ? "" : "s"}.`);
  });

program
  .argument("[prompt]", "The prompt or question to collaborate on")
  .option("--start-with <agent>", "Which agent goes first (claude or codex)", "claude")
  .option("--cwd <path>", "Working directory for agents", process.cwd())
  .option("--guardrail <rounds>", "Soft escalation after N rounds", "5")
  .option("--timeout <seconds>", "Timeout per agent turn in seconds", "900")
  .option("--output <format>", "Output format (text or json)", "text")
  .option("--transcript <path>", "Save full transcript to path")
  .option("--resume <sessionId>", "Resume a paused session")
  .option("--codex-sandbox <mode>", "Codex sandbox mode (read-only, workspace-write, danger-full-access)", "workspace-write")
  .option("--codex-web-search <mode>", "Codex web search (disabled, cached, live)", "live")
  .option("--codex-network", "Enable network access for Codex", true)
  .option("--no-codex-network", "Disable network access for Codex")
  .option("--codex-model <model>", "Override model for Codex agent")
  .option("--codex-reasoning <effort>", "Codex reasoning effort (minimal, low, medium, high, xhigh)")
  .option("--yolo", "Skip all permission checks: Claude gets --dangerously-skip-permissions, Codex gets full sandbox access")
  .action(async (prompt: string | undefined, opts) => {
    // Validate credentials
    if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_API_KEY) {
      console.error("Warning: ANTHROPIC_API_KEY not set. Claude Code will attempt to use your active login session.");
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error("Error: OPENAI_API_KEY is required for Codex.");
      console.error("Set it via: export OPENAI_API_KEY=your-key");
      process.exit(1);
    }

    const codexCfg: CodexConfig = {
      sandboxMode: opts.codexSandbox as CodexConfig["sandboxMode"],
      webSearchMode: opts.codexWebSearch as CodexConfig["webSearchMode"],
      networkAccessEnabled: !!opts.codexNetwork,
      approvalPolicy: "never",
      model: opts.codexModel,
      modelReasoningEffort: opts.codexReasoning as CodexConfig["modelReasoningEffort"],
    };

    const yolo = !!opts.yolo;

    const config: OrchestratorConfig = {
      startWith: opts.startWith as AgentName,
      workingDirectory: opts.cwd,
      guardrailRounds: parseInt(opts.guardrail, 10),
      timeoutMs: parseInt(opts.timeout, 10) * 1000,
      outputFormat: opts.output as "text" | "json",
      codex: codexCfg,
      yolo,
    };

    // Case 1: No prompt and no --resume → launch REPL
    if (!prompt && !opts.resume) {
      await startRepl(config);
      return;
    }

    // Case 2: --resume with no prompt → launch REPL with loaded session
    if (opts.resume && !prompt) {
      await startRepl(config, opts.resume as string);
      return;
    }

    // Case 3 & 4: One-shot mode (existing behavior)
    if (yolo) {
      console.error("WARNING: --yolo mode enabled. All permission checks are disabled.");
    }
    const claude = new ClaudeAdapter(config.timeoutMs, yolo);
    const codex = new CodexAdapter(config.timeoutMs, config.codex, yolo);
    const session = new SessionManager();

    // When resuming, restore the session's stored Codex config
    if (opts.resume) {
      try {
        const loaded = session.load(opts.resume as string);
        if (loaded.meta.config.codex) {
          codex.updateConfig(loaded.meta.config.codex);
        }
        // If launched with --yolo, re-apply yolo overrides so a saved session
        // can never downgrade permissions below what yolo guarantees.
        if (yolo) {
          codex.updateConfig({
            sandboxMode: "danger-full-access",
            approvalPolicy: "never",
            networkAccessEnabled: true,
          });
        }
      } catch (err) {
        console.error(`Failed to load session: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    const orchestrator = new Orchestrator(claude, codex, session, config, {
      onTurnStart: (turn, agent, role) => {
        const label = agent.charAt(0).toUpperCase() + agent.slice(1);
        console.error(`[Turn ${turn}] ${label} (${role}): responding...`);
      },
    });

    try {
      let result;

      if (opts.resume && prompt) {
        // Resume existing session with guidance (one-shot)
        const sessionId = opts.resume as string;
        console.error(`Resuming session: ${sessionId}`);
        console.error(`With guidance: "${prompt}"\n`);
        result = await orchestrator.resume(sessionId, prompt);
      } else {
        // New one-shot session
        console.error(`Starting collaboration (${config.startWith} goes first)...`);
        result = await orchestrator.run(prompt!);
        console.error(`Session ID: ${result.sessionId}`);
        console.error(`Resume with: topg --resume ${result.sessionId} "your guidance"\n`);
      }

      while (true) {
        if (config.outputFormat === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.summary);
        }

        if (result.type === "consensus") {
          break;
        }

        // Escalation — ask user for input
        console.error(`\nResume later with: topg --resume ${result.sessionId} "your guidance"`);
        const guidance = await askUser("\nYour guidance (or 'q' to quit): ");

        if (!guidance || guidance.toLowerCase() === "q") {
          break;
        }

        console.error(`\nResuming with your guidance...\n`);
        result = await orchestrator.continueWithGuidance(result, guidance, result.sessionId);
      }
    } catch (err) {
      console.error("Collaboration failed:", (err as Error).message);
      process.exit(1);
    }
  });

program.parse();
