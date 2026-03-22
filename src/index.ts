#!/usr/bin/env node

import { Command } from "commander";
import { createInterface } from "node:readline";
import { Orchestrator } from "./orchestrator.js";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { SessionManager } from "./session.js";
import { startRepl } from "./repl.js";
import type { AgentName, CodexConfig, OrchestratorConfig } from "./types.js";

function askUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const program = new Command();

program
  .name("topg")
  .description("Inter-agent collaboration between Claude Code and OpenAI Codex")
  .version("0.1.0")
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

    const config: OrchestratorConfig = {
      startWith: opts.startWith as AgentName,
      workingDirectory: opts.cwd,
      guardrailRounds: parseInt(opts.guardrail, 10),
      timeoutMs: parseInt(opts.timeout, 10) * 1000,
      outputFormat: opts.output as "text" | "json",
      codex: codexCfg,
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
    const claude = new ClaudeAdapter(config.timeoutMs);
    const codex = new CodexAdapter(config.timeoutMs, config.codex);
    const session = new SessionManager();

    // When resuming, restore the session's stored Codex config
    if (opts.resume) {
      try {
        const loaded = session.load(opts.resume as string);
        if (loaded.meta.config.codex) {
          codex.updateConfig(loaded.meta.config.codex);
        }
      } catch (err) {
        console.error(`Failed to load session: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    const orchestrator = new Orchestrator(claude, codex, session, config, (turn, agent, role) => {
      const label = agent.charAt(0).toUpperCase() + agent.slice(1);
      console.error(`[Turn ${turn}] ${label} (${role}): responding...`);
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
