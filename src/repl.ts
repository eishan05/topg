import { createInterface } from "node:readline";
import chalk from "chalk";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { Orchestrator } from "./orchestrator.js";
import { SessionManager } from "./session.js";
import type { Message, OrchestratorConfig, OrchestratorResult } from "./types.js";

// --- Command parsing ---

export interface ParsedCommand {
  command: string;
  args: string;
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: trimmed.slice(1), args: "" };
  }
  return {
    command: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

// --- Spinner ---

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  start(message: string, turn: number, maxTurns: number): void;
  update(message: string, turn: number, maxTurns: number): void;
  stop(): void;
}

export function createSpinner(write: (text: string) => void): Spinner {
  let frameIdx = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentMessage = "";
  let currentTurn = 0;
  let currentMax = 0;

  function render() {
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    const turnDisplay = currentTurn > currentMax
      ? "escalating..."
      : `turn ${currentTurn}/${currentMax}`;
    write(`\r${frame} ${currentMessage} ${turnDisplay}`);
    frameIdx++;
  }

  return {
    start(message, turn, maxTurns) {
      currentMessage = message;
      currentTurn = turn;
      currentMax = maxTurns;
      frameIdx = 0;
      if (interval) clearInterval(interval);
      interval = setInterval(render, 80);
      render();
    },
    update(message, turn, maxTurns) {
      currentMessage = message;
      currentTurn = turn;
      currentMax = maxTurns;
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      write("\r\x1b[K");
    },
  };
}

// --- REPL State ---

interface ReplState {
  sessionId: string;
  messages: Message[];
  roundIndex: number;
  roundStartTurn: number;
  config: OrchestratorConfig;
  lastResult: OrchestratorResult | null;
  debateInProgress: boolean;
  escalationPending: boolean;
}

// --- REPL ---

export async function startRepl(
  config: OrchestratorConfig,
  resumeSessionId?: string
): Promise<void> {
  const session = new SessionManager();
  const claude = new ClaudeAdapter(config.timeoutMs);
  const codex = new CodexAdapter(config.timeoutMs);

  const spinner = createSpinner((text) => process.stderr.write(text));

  let abortController: AbortController | null = null;

  // State must be declared before onTurnStart so it can reference state
  const state: ReplState = {
    sessionId: "",
    messages: [],
    roundIndex: 0,
    roundStartTurn: 1,
    config,
    lastResult: null,
    debateInProgress: false,
    escalationPending: false,
  };

  const onTurnStart = (turn: number, agent: string, role: string) => {
    const label = agent === "claude"
      ? chalk.magenta("Claude")
      : chalk.green("Codex");
    const relativeTurn = turn - state.roundStartTurn + 1;
    if (role === "escalation") {
      spinner.update(`${label} (${role}) responding...`, state.config.guardrailRounds + 1, state.config.guardrailRounds);
    } else {
      spinner.start(`${label} (${role}) responding...`, relativeTurn, state.config.guardrailRounds);
    }
  };

  let orchestrator = new Orchestrator(claude, codex, session, config, { onTurnStart });

  // Load or create session
  if (resumeSessionId) {
    const loaded = session.load(resumeSessionId);
    state.sessionId = resumeSessionId;
    state.messages = loaded.messages;
    state.roundStartTurn = Math.max(...loaded.messages.map((m) => m.turn), 0) + 1;
    state.config = { ...config, ...loaded.meta.config };
    orchestrator = new Orchestrator(claude, codex, session, state.config, { onTurnStart });
    session.updateStatus(resumeSessionId, "active");
  } else {
    const meta = session.create("(interactive session)", config);
    state.sessionId = meta.sessionId;
  }

  // Welcome banner
  process.stderr.write(`\n${chalk.bold("topg")} — inter-agent collaboration\n`);
  process.stderr.write(`Session: ${chalk.dim(state.sessionId)}\n`);
  process.stderr.write(`Agents: ${chalk.magenta("Claude")} vs ${chalk.green("Codex")} (${state.config.startWith} goes first)\n`);
  process.stderr.write(`Type a prompt to start a debate, or ${chalk.dim("/help")} for commands.\n\n`);

  // Readline
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: chalk.bold("topg> "),
  });

  // --- Slash command handlers ---
  const commands = new Map<string, (args: string) => void | Promise<void>>();

  commands.set("quit", () => {
    session.updateStatus(state.sessionId, "paused");
    process.stderr.write(`\nSession paused. Resume with: ${chalk.dim(`topg --resume ${state.sessionId}`)}\n`);
    rl.close();
    process.exit(0);
  });

  commands.set("help", () => {
    process.stderr.write(chalk.dim([
      "",
      "  /quit              Exit the REPL",
      "  /transcript        Show full transcript of last round",
      "  /history           Show summary of all rounds",
      "  /sessions          List all saved sessions",
      "  /resume <id>       Switch to a different session",
      "  /steer <text>      Provide guidance after escalation",
      "  /status            Show current session info",
      "  /config [key] [val] View or change settings",
      "  /help              Show this help",
      "",
    ].join("\n")) + "\n");
  });

  commands.set("status", () => {
    process.stderr.write(chalk.dim([
      "",
      `  Session:    ${state.sessionId}`,
      `  Rounds:     ${state.roundIndex}`,
      `  Start with: ${state.config.startWith}`,
      `  Guardrail:  ${state.config.guardrailRounds} rounds`,
      `  Timeout:    ${state.config.timeoutMs / 1000}s per turn`,
      `  Last:       ${state.lastResult ? state.lastResult.type : "none"}`,
      "",
    ].join("\n")) + "\n");
  });

  commands.set("transcript", () => {
    if (state.messages.length === 0) {
      process.stderr.write(chalk.dim("  No messages yet.\n\n"));
      return;
    }
    // Show messages from the most recent round
    const agentMessages = state.messages.filter((m) => m.type !== "user-prompt");
    // Find messages from current round (after the last user-prompt)
    const lastUserPromptIdx = [...state.messages].reverse().findIndex((m) => m.type === "user-prompt");
    const startIdx = lastUserPromptIdx >= 0 ? state.messages.length - lastUserPromptIdx : 0;
    const roundMessages = state.messages.slice(startIdx).filter((m) => m.type !== "user-prompt");
    const msgs = roundMessages.length > 0 ? roundMessages : agentMessages;

    process.stderr.write("\n");
    for (const msg of msgs) {
      const label = msg.agent === "claude"
        ? chalk.magenta("Claude")
        : chalk.green("Codex");
      process.stderr.write(`  ${chalk.dim(`[Turn ${msg.turn}]`)} ${label} (${msg.role}):\n`);
      process.stderr.write(`  ${msg.content.split("\n").join("\n  ")}\n\n`);
    }
  });

  commands.set("history", () => {
    if (state.roundIndex === 0) {
      process.stderr.write(chalk.dim("  No rounds yet.\n\n"));
      return;
    }
    process.stderr.write("\n");
    const userPrompts = state.messages.filter((m) => m.type === "user-prompt");
    for (let i = 0; i < userPrompts.length; i++) {
      const promptSnippet = userPrompts[i].content.replace(`[USER PROMPT #${i + 1}]: `, "").slice(0, 60);
      const outcome = state.lastResult && i === userPrompts.length - 1 ? state.lastResult.type : "completed";
      process.stderr.write(chalk.dim(`  Round ${i + 1}: "${promptSnippet}" → ${outcome}\n`));
    }
    process.stderr.write("\n");
  });

  commands.set("sessions", () => {
    const allSessions = session.listSessions();
    if (allSessions.length === 0) {
      process.stderr.write(chalk.dim("  No sessions found.\n\n"));
      return;
    }
    process.stderr.write("\n");
    for (const s of allSessions) {
      const current = s.sessionId === state.sessionId ? chalk.green(" (current)") : "";
      const date = new Date(s.updatedAt).toLocaleDateString();
      const snippet = s.prompt.slice(0, 50);
      process.stderr.write(chalk.dim(`  ${s.sessionId}  ${date}  ${s.status.padEnd(10)}  "${snippet}"${current}\n`));
    }
    process.stderr.write("\n");
  });

  commands.set("resume", (args) => {
    const targetId = args.trim();
    if (!targetId) {
      process.stderr.write(chalk.dim("  Usage: /resume <sessionId>\n\n"));
      return;
    }
    try {
      const loaded = session.load(targetId);
      state.sessionId = targetId;
      state.messages = loaded.messages;
      state.roundIndex = loaded.messages.filter((m) => m.type === "user-prompt").length;
      state.roundStartTurn = Math.max(...loaded.messages.map((m) => m.turn), 0) + 1;
      state.lastResult = null;
      state.escalationPending = false;
      Object.assign(state.config, loaded.meta.config);
      orchestrator = new Orchestrator(claude, codex, session, state.config, { onTurnStart });
      session.updateStatus(targetId, "active");
      process.stderr.write(`  Switched to session ${chalk.dim(targetId)} (${state.roundIndex} rounds)\n\n`);
    } catch {
      process.stderr.write(chalk.red(`  Session not found: ${targetId}\n\n`));
    }
  });

  commands.set("steer", async (args) => {
    const guidance = args.trim();
    if (!guidance) {
      process.stderr.write(chalk.dim("  Usage: /steer <your guidance>\n\n"));
      return;
    }
    if (!state.escalationPending || !state.lastResult) {
      process.stderr.write(chalk.dim("  No pending escalation to steer. Submit a new prompt instead.\n\n"));
      return;
    }
    state.debateInProgress = true;
    state.escalationPending = false;
    abortController = new AbortController();
    spinner.start("Resuming with guidance...", 1, state.config.guardrailRounds);
    try {
      const result = await orchestrator.continueWithGuidance(
        state.lastResult,
        guidance,
        state.sessionId,
        abortController.signal
      );
      spinner.stop();
      state.debateInProgress = false;
      state.lastResult = result;
      state.messages = result.messages;
      state.roundStartTurn = Math.max(...state.messages.map((m) => m.turn), 0) + 1;

      if (result.type === "consensus") {
        process.stderr.write(chalk.green("✓") + ` Consensus reached (${result.rounds} rounds)\n\n`);
      } else {
        process.stderr.write(chalk.yellow("⚠") + ` Escalation (${result.rounds} rounds, no convergence)\n\n`);
        state.escalationPending = true;
      }
      console.log(result.summary);
    } catch (err) {
      spinner.stop();
      state.debateInProgress = false;
      if ((err as Error).message === "aborted") {
        state.messages = state.messages.filter((m) => m.turn < state.roundStartTurn);
        process.stderr.write(chalk.dim("\n  Debate interrupted.\n\n"));
      } else {
        process.stderr.write(chalk.red(`  Error: ${(err as Error).message}\n\n`));
      }
    }
  });

  commands.set("config", (args) => {
    const parts = args.trim().split(/\s+/);
    if (!args.trim()) {
      process.stderr.write(chalk.dim([
        "",
        `  startWith:       ${state.config.startWith}`,
        `  guardrailRounds: ${state.config.guardrailRounds}`,
        `  timeoutMs:       ${state.config.timeoutMs}`,
        `  outputFormat:    ${state.config.outputFormat}`,
        "",
      ].join("\n")) + "\n");
      return;
    }
    const [key, value] = parts;
    if (key === "startWith" && (value === "claude" || value === "codex")) {
      state.config.startWith = value;
      orchestrator = new Orchestrator(claude, codex, session, state.config, { onTurnStart });
      process.stderr.write(chalk.dim(`  startWith set to ${value}\n\n`));
    } else if (key === "guardrailRounds" && !isNaN(parseInt(value, 10))) {
      state.config.guardrailRounds = parseInt(value, 10);
      process.stderr.write(chalk.dim(`  guardrailRounds set to ${value}\n\n`));
    } else if (key === "timeoutMs" && !isNaN(parseInt(value, 10))) {
      state.config.timeoutMs = parseInt(value, 10);
      process.stderr.write(chalk.dim(`  timeoutMs set to ${value}\n\n`));
    } else {
      process.stderr.write(chalk.dim(`  Unknown config key or invalid value: ${key} ${value ?? ""}\n\n`));
    }
  });

  // --- Debate submission ---
  async function submitPrompt(prompt: string) {
    state.roundIndex++;
    state.escalationPending = false;

    const userMsg: Message = {
      role: "initiator",
      agent: "claude",
      turn: state.roundStartTurn,
      type: "user-prompt",
      content: `[USER PROMPT #${state.roundIndex}]: ${prompt}`,
      timestamp: new Date().toISOString(),
    };
    state.messages.push(userMsg);
    session.appendMessage(state.sessionId, userMsg);
    state.roundStartTurn = Math.max(...state.messages.map((m) => m.turn), 0) + 1;

    if (state.roundIndex === 1) {
      session.updatePrompt(state.sessionId, prompt);
    }

    state.debateInProgress = true;
    abortController = new AbortController();
    spinner.start(
      `${chalk.magenta("Claude")} (initiator) responding...`,
      1,
      state.config.guardrailRounds
    );

    try {
      const result = await orchestrator.runWithHistory(
        prompt,
        state.messages,
        state.sessionId,
        abortController.signal
      );
      spinner.stop();
      state.debateInProgress = false;
      state.lastResult = result;
      state.messages = result.messages;
      state.roundStartTurn = Math.max(...state.messages.map((m) => m.turn), 0) + 1;

      if (result.type === "consensus") {
        process.stderr.write(chalk.green("✓") + ` Consensus reached (${result.rounds} rounds)\n\n`);
        console.log(result.summary);
      } else {
        process.stderr.write(chalk.yellow("⚠") + ` Escalation (${result.rounds} rounds, no convergence)\n\n`);
        console.log(result.summary);
        state.escalationPending = true;
        process.stderr.write(chalk.dim("\nProvide guidance with /steer <text>, or submit a new prompt.\n\n"));
      }
    } catch (err) {
      spinner.stop();
      state.debateInProgress = false;
      if ((err as Error).message === "aborted") {
        state.messages = state.messages.filter((m) => m.turn < state.roundStartTurn);
        process.stderr.write(chalk.dim("\n  Debate interrupted.\n\n"));
      } else {
        process.stderr.write(chalk.red(`  Error: ${(err as Error).message}\n\n`));
      }
    }
  }

  // --- Ctrl+C handling ---
  rl.on("SIGINT", () => {
    if (state.debateInProgress && abortController) {
      abortController.abort();
    } else {
      session.updateStatus(state.sessionId, "paused");
      process.stderr.write(`\n\nSession paused. Resume with: ${chalk.dim(`topg --resume ${state.sessionId}`)}\n`);
      process.exit(0);
    }
  });

  // --- Main loop ---
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    const cmd = parseCommand(trimmed);
    if (cmd) {
      const handler = commands.get(cmd.command);
      if (handler) {
        await handler(cmd.args);
      } else {
        process.stderr.write(chalk.dim(`  Unknown command: /${cmd.command}. Type /help for available commands.\n\n`));
      }
    } else {
      await submitPrompt(trimmed);
    }

    rl.prompt();
  }

  // EOF / readline close
  session.updateStatus(state.sessionId, "paused");
  process.stderr.write(`\nSession paused. Resume with: ${chalk.dim(`topg --resume ${state.sessionId}`)}\n`);
}

// Note: No askGuidance helper — inline guidance uses /steer command
// to avoid readline question/iterator conflicts. After escalation,
// the user is prompted to use /steer <text> from the main prompt.
